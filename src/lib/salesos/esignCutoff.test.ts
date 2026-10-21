import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture notifications through the central domain map so we can assert the DOMAIN (sales-ai) + the honest
// copy, without a real Slack post.
const posts: { domain: string; message: unknown }[] = [];
vi.mock("@/lib/notify/channels", () => ({
  notify: async (domain: string, message: unknown) => {
    posts.push({ domain, message });
    return { ok: true } as const;
  },
}));

import { saveBookings, listGsOps, ackGsOp, listPendingGsOps } from "@/lib/db/repo";
import { getDb } from "@/lib/db";
import {
  runEsignCutoffSweep,
  pendingCutoffCard,
  confirmedCutoffCard,
  esignCutoffEnabled,
} from "@/lib/salesos/esignCutoff";
import type { BookingView } from "@/lib/db/repo";

// Anchored to Mon 2026-10-19 (ET): Thu 2026-10-22 is exactly 3 business days out; the next Mon 2026-10-26
// is 5 business days out; last Fri 2026-10-16 is in the past.
const MON = new Date("2026-10-19T15:00:00Z");

function seed(bookingId: string, eventDate: string, opts: { signed?: boolean; archived?: boolean; status?: string } = {}): void {
  saveBookings([
    {
      bookingId,
      eventName: `Event ${bookingId}`,
      clientName: "Client",
      eventDate,
      signed: opts.signed ?? false,
      archived: opts.archived ?? false,
      statusLabel: opts.status ?? "Quote",
    },
  ]);
}

beforeEach(() => {
  getDb().prepare("DELETE FROM bookings").run();
  getDb().prepare("DELETE FROM gs_outbox").run();
  getDb().prepare("DELETE FROM settings WHERE key = 'esign.cutoff.confirmedAnnounced'").run();
  posts.length = 0;
  process.env.ESIGN_CUTOFF_ENABLED = "true";
});
afterEach(() => {
  delete process.env.ESIGN_CUTOFF_ENABLED;
  delete process.env.ESIGN_CUTOFF_BUSINESS_DAYS;
});

const esignOps = () => listGsOps(100).filter((o) => o.op === "disable_esignature");

describe("runEsignCutoffSweep detection", () => {
  it("queues + announces a project exactly 3 business days out, to sales-ai", async () => {
    seed("IN", "2026-10-22"); // Thu = 3 biz days
    const r = await runEsignCutoffSweep(MON);
    expect(r.queued).toBe(1);
    const ops = esignOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].transactionId).toBe("IN");
    expect(ops[0].payload).toMatchObject({ transactionId: "IN" });
    // Announced to the sales domain (sales-ai), with honest PENDING copy — never claims it's disabled.
    expect(posts).toHaveLength(1);
    expect(posts[0].domain).toBe("sales");
  });

  it("does NOT queue a project 5 business days out, a past event, a signed or archived project", async () => {
    seed("FAR", "2026-10-26"); // next Mon = 5 biz days
    seed("PAST", "2026-10-16"); // last Fri
    seed("SIGNED", "2026-10-22", { signed: true });
    seed("ARCHIVED", "2026-10-22", { archived: true });
    seed("LOST", "2026-10-22", { status: "Lost" });
    const r = await runEsignCutoffSweep(MON);
    expect(r.queued).toBe(0);
    expect(esignOps()).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("is idempotent — a project is queued once even across repeated sweeps", async () => {
    seed("ONCE", "2026-10-22");
    await runEsignCutoffSweep(MON);
    await runEsignCutoffSweep(MON);
    await runEsignCutoffSweep(MON);
    expect(esignOps()).toHaveLength(1);
    expect(posts).toHaveLength(1);
  });

  it("is a no-op when ESIGN_CUTOFF_ENABLED is off", async () => {
    delete process.env.ESIGN_CUTOFF_ENABLED;
    expect(esignCutoffEnabled()).toBe(false);
    seed("OFF", "2026-10-22");
    const r = await runEsignCutoffSweep(MON);
    expect(r.detail).toContain("off");
    expect(esignOps()).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("posts the CONFIRMED follow-up only once, after the op lands", async () => {
    seed("CONF", "2026-10-22");
    await runEsignCutoffSweep(MON); // queues + pending announce
    posts.length = 0;
    // Simulate the office drainer confirming the write (op -> done).
    const pending = listPendingGsOps(100).find((o) => o.op === "disable_esignature");
    expect(pending).toBeTruthy();
    ackGsOp(pending!.id, true);
    await runEsignCutoffSweep(MON);
    expect(posts.filter((p) => p.domain === "sales")).toHaveLength(1);
    // A further sweep must not re-announce the same confirmed op.
    await runEsignCutoffSweep(MON);
    expect(posts.filter((p) => p.domain === "sales")).toHaveLength(1);
  });
});

describe("honest announcement copy (no em-dash, no emoji)", () => {
  const b: BookingView = {
    bookingId: "99",
    eventName: "Garden Wedding",
    eventDate: "2026-10-22",
  } as BookingView;

  const noDashOrEmoji = (s: string) => {
    expect(s).not.toMatch(/—|–/); // no em/en dashes
    expect(s).not.toMatch(/\p{Extended_Pictographic}/u); // no emoji
  };

  it("PENDING copy says pending + reversible, never claims it is disabled", () => {
    const card = pendingCutoffCard(b, 3, 3);
    const text = JSON.stringify(card);
    expect(text).toMatch(/pending/i); // the card states the write is pending (not confirmed)
    expect(card.body).toMatch(/reversible/i);
    expect(card.body).toMatch(/in person/i);
    expect(card.body?.toLowerCase()).not.toContain("has been disabled");
    expect(card.body?.toLowerCase()).not.toContain("is now off");
    noDashOrEmoji(text);
  });

  it("CONFIRMED copy states online signing is disabled", () => {
    const card = confirmedCutoffCard("Garden Wedding", "99");
    expect(card.title.toLowerCase()).toContain("disabled");
    expect(card.body).toMatch(/off/i);
    noDashOrEmoji(JSON.stringify(card));
  });
});
