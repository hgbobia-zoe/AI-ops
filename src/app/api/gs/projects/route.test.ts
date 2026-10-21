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
