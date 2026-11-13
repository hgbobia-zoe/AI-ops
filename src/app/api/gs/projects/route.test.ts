// The bookings ingest route's orphan-prune behaviour: the conservative cap, and the human-armed one-shot
// Force-archive override. Uses the real in-memory DB. Each case starts from a clean bookings + settings
// slate so the >=100 floor and the >15 cap are exercised deterministically.

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { saveBookings, type BookingRecord } from "@/lib/db/repo";
import { armBookingsForcePrune, isBookingsForcePruneArmed } from "@/lib/ingest/forcePruneBookings";
import { POST } from "./route";

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM bookings").run();
  db.prepare("DELETE FROM settings WHERE key IN ('pull_state','bookings_force_prune_once')").run();
});

// Seed N active (non-archived) orphan rows that will NOT be in the next pull.
function seedOrphans(n: number): void {
  const rows: BookingRecord[] = [];
  for (let i = 1; i <= n; i++) rows.push({ bookingId: `ORPHAN-${i}`, eventName: `Deleted ${i}`, statusLabel: "Quote", archived: false });
  saveBookings(rows);
}

// Build a pull body of N fresh projects (ids PULL-1..PULL-N), none of which are the orphans.
function pullBody(n: number, extra: Record<string, unknown> = {}): string {
  const projects = [];
  for (let i = 1; i <= n; i++) projects.push({ bookingId: `PULL-${i}`, eventName: `Live ${i}`, statusLabel: "Quote" });
  return JSON.stringify({ projects, ...extra });
}

function req(body: string): Request {
  return new Request("http://localhost/api/gs/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const activeCount = (): number =>
  (getDb().prepare("SELECT COUNT(*) AS c FROM bookings WHERE COALESCE(archived,0) = 0").get() as { c: number }).c;

describe("POST /api/gs/projects — orphan prune", () => {
  it("(4) UNARMED: a complete pull with more orphans than the cap SKIPS the prune (orphans linger)", async () => {
    seedOrphans(30); // 30 > cap of 15
    const res = await POST(req(pullBody(100)));
    const json = (await res.json()) as { ok: boolean; pruned: number };
    expect(res.status).toBe(200);
    expect(json.pruned).toBe(0); // skipped, nothing archived
    expect(activeCount()).toBe(130); // 30 orphans + 100 pulled, all still active
  });

  it("(1) ARMED + complete pull archives beyond the cap AND disarms the one-shot", async () => {
    seedOrphans(30);
    armBookingsForcePrune();
    const res = await POST(req(pullBody(100)));
    const json = (await res.json()) as { ok: boolean; pruned: number };
    expect(res.status).toBe(200);
    expect(json.pruned).toBe(30); // all 30 orphans archived despite exceeding the cap of 15
    expect(activeCount()).toBe(100); // only the pulled set remains active
    expect(isBookingsForcePruneArmed()).toBe(false); // one-shot consumed
  });

  it("(2) ARMED + PARTIAL pull does NOT force, does NOT archive, and PRESERVES the arming", async () => {
    seedOrphans(30);
    armBookingsForcePrune();
    const res = await POST(req(pullBody(100, { partial: true })));
    const json = (await res.json()) as { pruned: number; partial: boolean };
    expect(json.partial).toBe(true);
    expect(json.pruned).toBe(0); // partial never prunes
    expect(activeCount()).toBe(130); // nothing archived
    expect(isBookingsForcePruneArmed()).toBe(true); // flag preserved for the next COMPLETE pull
  });

  it("(2b) a totalReported greater than the saved count is treated as partial and never forces", async () => {
    seedOrphans(30);
    armBookingsForcePrune();
    const res = await POST(req(pullBody(100, { totalReported: 500 })));
    const json = (await res.json()) as { pruned: number; partial: boolean };
    expect(json.partial).toBe(true);
    expect(json.pruned).toBe(0);
    expect(activeCount()).toBe(130);
    expect(isBookingsForcePruneArmed()).toBe(true);
  });

  it("(3) ARMED + tiny pull (<100) does NOT force or archive, and PRESERVES the arming", async () => {
    seedOrphans(30);
    armBookingsForcePrune();
    const res = await POST(req(pullBody(50))); // below the >=100 floor
    const json = (await res.json()) as { pruned: number };
    expect(json.pruned).toBe(0);
    expect(activeCount()).toBe(80); // 30 orphans + 50 pulled, all active
    expect(isBookingsForcePruneArmed()).toBe(true); // not consumed on an ineligible pull
  });

  it("UNARMED: a complete pull with FEW orphans (<= cap) still prunes normally", async () => {
    seedOrphans(10); // 10 <= cap of 15
    const res = await POST(req(pullBody(100)));
    const json = (await res.json()) as { pruned: number };
    expect(json.pruned).toBe(10);
    expect(activeCount()).toBe(100);
  });

  it("scope defaults to 'full' when absent (back-compat: an absent scope still prunes)", async () => {
    seedOrphans(10);
    const res = await POST(req(pullBody(100))); // no scope field
    const json = (await res.json()) as { pruned: number; scope: string };
    expect(json.scope).toBe("full");
    expect(json.pruned).toBe(10); // behaved exactly like the pre-two-tier full pull
  });
});

// The CRITICAL safety invariant: a scope:"active" pull carries no archived rows, so it must NEVER be
// allowed to prune — otherwise every archived project would look like an orphan and get mass-archived.
describe("POST /api/gs/projects — active lane NEVER prunes", () => {
  // Seed N ARCHIVED rows directly (what the DB looks like after many full pulls have accumulated history).
  function seedArchived(n: number): void {
    const rows: BookingRecord[] = [];
    for (let i = 1; i <= n; i++) rows.push({ bookingId: `ARCHIVED-${i}`, eventName: `Old ${i}`, statusLabel: "Won", archived: true });
    saveBookings(rows);
  }
  const archivedCount = (): number =>
    (getDb().prepare("SELECT COUNT(*) AS c FROM bookings WHERE COALESCE(archived,0) = 1").get() as { c: number }).c;

  it("a small active pull NEVER archives anything, even with thousands of archived rows in the DB", async () => {
    seedArchived(3000); // a realistic full-history DB
    seedOrphans(5); // 5 active rows that are NOT in the active pull (would be orphans on a full pull)
    const res = await POST(req(pullBody(10, { scope: "active" }))); // tiny active-only set
    const json = (await res.json()) as { ok: boolean; scope: string; pruned: number; partial: boolean };
    expect(res.status).toBe(200);
    expect(json.scope).toBe("active");
    expect(json.pruned).toBe(0); // nothing pruned
    expect(json.partial).toBe(false);
    expect(archivedCount()).toBe(3000); // every archived row is untouched
    expect(activeCount()).toBe(15); // 5 prior orphans + 10 pulled, all still active (none archived)
  });

  it("an active pull does NOT consume an armed force-prune flag", async () => {
    armBookingsForcePrune();
    seedArchived(3000);
    const res = await POST(req(pullBody(10, { scope: "active" })));
    await res.json();
    expect(isBookingsForcePruneArmed()).toBe(true); // the one-shot survives for the next FULL pull
  });

  it("an active pull still records freshness (recordPull) so the ledger stays green", async () => {
    const res = await POST(req(pullBody(10, { scope: "active" })));
    const json = (await res.json()) as { ok: boolean; saved: number };
    expect(json.ok).toBe(true);
    expect(json.saved).toBe(10);
    const pull = getDb().prepare("SELECT value FROM settings WHERE key = 'pull_state'").get() as { value: string } | undefined;
    expect(pull).toBeTruthy(); // recordPull wrote bookings freshness
    const state = JSON.parse(pull!.value) as { sources?: Record<string, { count: number }> };
    expect(state.sources?.bookings?.count).toBe(10);
  });
});

describe("POST /api/gs/projects — sales lead", () => {
  const lead = (): unknown => (getDb().prepare("SELECT sales_lead FROM bookings WHERE booking_id = 'SL-1'").get() as { sales_lead: unknown }).sales_lead;
  const pull = (extra: Record<string, unknown>) => POST(req(JSON.stringify({ scope: "active", projects: [{ bookingId: "SL-1", eventName: "A", statusLabel: "Quote Sent", ...extra }] })));
  it("stores the Goodshuffle sales lead and keeps it when an older pull does not send it", async () => {
    await pull({ salesLead: "Jessie Medalla" });
    expect(lead()).toBe("Jessie Medalla");
    await pull({});
    expect(lead()).toBe("Jessie Medalla");
    await pull({ salesLead: "Pat Lee" });
    expect(lead()).toBe("Pat Lee");
  });
});

describe("POST /api/gs/projects — date drift guard", () => {
  const row = (id: string) =>
    (getDb().prepare("SELECT event_date, quote_sent_date, date_created, window_start_time FROM bookings WHERE booking_id = ?").get(id) as Record<string, string | null>);

  it("a pull where no project has a created date (an out-of-date pull build) keeps the stored dates", async () => {
    const seeded: BookingRecord[] = [];
    for (let i = 1; i <= 6; i++)
      seeded.push({ bookingId: `D-${i}`, eventName: `E${i}`, statusLabel: "Quote Sent", eventDate: "2026-12-07", quoteSentDate: "2026-11-05", dateCreated: "2026-11-03", windowStartTime: "9:00 AM EST" });
    saveBookings(seeded);
    // What the old pull sends after Goodshuffle renamed its date fields: every date blank.
    const projects = seeded.map((s) => ({ bookingId: s.bookingId, eventName: s.eventName, statusLabel: "Contract Signed", eventDate: null, quoteSentDate: null, dateCreated: null, logisticsStartTime: null }));
    const res = await POST(req(JSON.stringify({ projects })));
    expect(res.status).toBe(200);
    expect(row("D-1")).toEqual({ event_date: "2026-12-07", quote_sent_date: "2026-11-05", date_created: "2026-11-03", window_start_time: "9:00 AM EST" });
    // The rest of the row still updates.
    expect((getDb().prepare("SELECT status_label FROM bookings WHERE booking_id = 'D-1'").get() as { status_label: string }).status_label).toBe("Contract Signed");
  });

  it("a normal pull still clears a delivery date Goodshuffle removed", async () => {
    saveBookings([{ bookingId: "C-1", eventName: "X", statusLabel: "Quote Sent", eventDate: "2026-12-07", dateCreated: "2026-11-03" }]);
    const projects = [{ bookingId: "C-1", eventName: "X", statusLabel: "Quote Sent", eventDate: null, dateCreated: "2026-11-03" }];
    for (let i = 2; i <= 6; i++) projects.push({ bookingId: `C-${i}`, eventName: "Y", statusLabel: "Quote Sent", eventDate: "2026-12-01", dateCreated: "2026-11-01" });
    await POST(req(JSON.stringify({ projects })));
    expect(row("C-1").event_date).toBeNull();
    expect(row("C-2").event_date).toBe("2026-12-01");
  });
});

describe("POST /api/gs/projects — short sweep never prunes", () => {
  const full = (n: number, extra: Record<string, unknown> = {}) => pullBody(n, { scope: "full", ...extra });

  it("a sweep short of Goodshuffle's count skips the prune and says why", async () => {
    seedOrphans(5);
    const res = await POST(req(full(100, { totalReported: 120 })));
    const json = (await res.json()) as { pruned: number; partial: boolean; pruneSkipped: string | null };
    expect(json.pruned).toBe(0);
    expect(json.partial).toBe(true);
    expect(json.pruneSkipped).toContain("20 short of Goodshuffle's count (120)");
    expect(activeCount()).toBe(105); // the 5 "orphans" were only missed, not deleted: still active
  });

  it("a sweep that reaches Goodshuffle's count prunes the real orphans", async () => {
    seedOrphans(5);
    const res = await POST(req(full(100, { totalReported: 100 })));
    expect(((await res.json()) as { pruned: number }).pruned).toBe(5);
    expect(activeCount()).toBe(100);
  });

  it("the cap of 15 still holds on a complete sweep", async () => {
    seedOrphans(16);
    const res = await POST(req(full(100, { totalReported: 100 })));
    expect(((await res.json()) as { pruned: number }).pruned).toBe(0);
    expect(activeCount()).toBe(116);
  });

  it("an older pull build that sends no total: a sweep far short of this week's projects skips the prune", async () => {
    // 200 projects pulled this week, then a one sort sweep that only sees 150 of them (and finds 10 of the
    // missing ones still active in our table).
    const seen: BookingRecord[] = [];
    for (let i = 1; i <= 200; i++) seen.push({ bookingId: `PULL-${i}`, eventName: `Live ${i}`, statusLabel: "Quote", archived: i > 10 && i <= 150 ? false : i > 150 && i <= 160 ? false : true });
    saveBookings(seen);
    const res = await POST(req(full(150)));
    const json = (await res.json()) as { pruned: number; pruneSkipped: string | null };
    expect(json.pruned).toBe(0);
    expect(json.pruneSkipped).toContain("50 short of the 200 seen this week");
  });

  it("an older pull build with a normal sweep still prunes a real deletion", async () => {
    seedOrphans(3);
    const res = await POST(req(full(100)));
    expect(((await res.json()) as { pruned: number }).pruned).toBe(3);
  });
});
