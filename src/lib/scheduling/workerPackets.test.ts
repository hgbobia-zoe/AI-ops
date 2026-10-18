import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the two external surfaces the send path reaches: the SMS provider (so no real text is sent and we
// can count sends) and the Connecteam roster (so an internal worker resolves to a phone). Everything else
// — packet build, templates, assignments, idempotency ledger — runs for real against the throwaway DB.
vi.mock("@/lib/notify/sms", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify/sms")>()),
  sendSms: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/connecteam", async (orig) => ({
  ...(await orig<typeof import("@/lib/connecteam")>()),
  connecteamConfigured: () => true,
  getUsers: async () => new Map([[101, { userId: 101, name: "Pat", phone: "+13015551212" }]]),
}));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-wpackets-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
  // PUBLIC_BASE_URL deliberately unset → the refresher link drops (honest), no pass rows needed.
  delete process.env.PUBLIC_BASE_URL;
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(async () => {
  process.env.AUTO_PACKET_ENABLED = "true";
  process.env.SHIFT_COMMS_ENABLED = "true";
  process.env.SMS_SEND_ENABLED = "true";
  // Per-test isolation: the in-memory DB connection survives the whole file, so clear the shift tables
  // between tests (otherwise one test's committed shift would be re-processed by the next).
  const { getDb } = await import("@/lib/db");
  for (const t of ["staff_shifts", "shift_assignments", "shift_assignment_events", "shift_packets"]) {
    try {
      getDb().prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist in a given schema revision */
    }
  }
});
afterEach(() => {
  vi.clearAllMocks();
  delete process.env.AUTO_PACKET_ENABLED;
  delete process.env.SHIFT_COMMS_ENABLED;
  delete process.env.SMS_SEND_ENABLED;
});

async function mods() {
  const wp = await import("./workerPackets");
  const store = await import("./store");
  const assign = await import("./assignments");
  const dates = await import("@/lib/dates");
  const sms = await import("@/lib/notify/sms");
  const db = await import("@/lib/db");
  return { ...wp, ...store, ...assign, ...dates, sms, db };
}

/** Create a COMMITTED (provisioned) ROUTE shift today with a given window, and return it. Route crew only
 *  are auto-debriefed (owner rule), so this is a DRIVER shift carrying a routeId + truckId. We create NO
 *  route row, so preCheckGateForShift finds no present route and returns null (gate is a no-op) — the send
 *  path proceeds without route/vehicle fixtures. */
async function committedShift(m: Awaited<ReturnType<typeof mods>>, startMs: number | null, endMs: number | null) {
  const date = m.todayInOpsTz();
  const s = m.createShift({
    date,
    role: "driver",
    headcount: 1,
    routeId: "R-TEST-1",
    truckId: "T-TEST-1",
    startTime: startMs != null ? new Date(startMs).toISOString() : null,
    endTime: endMs != null ? new Date(endMs).toISOString() : null,
    windowKnown: startMs != null,
  });
  // Mark committed: set the Connecteam linkage + 'sent' status (what shiftCommitted() reads).
  m.db.getDb().prepare("UPDATE staff_shifts SET connecteam_shift_id = ?, status = 'sent' WHERE id = ?").run(`CT-${s.id}`, s.id);
  return m.getShiftById(s.id)!;
}

// ── Pure due-window logic (single debrief, ~2h before, route crew only) ─────────────────────────────────
describe("dueTouches (pure)", () => {
  it("returns nothing for a cancelled, uncommitted, already-started, or already-ended shift", async () => {
    const { dueTouches } = await import("./workerPackets");
    const now = Date.now();
    const base = { startMs: now + 3_600_000, endMs: now + 7_200_000, windowKnown: true, committed: true, cancelled: false };
    expect(dueTouches({ ...base, cancelled: true }, now)).toEqual([]);
    expect(dueTouches({ ...base, committed: false }, now)).toEqual([]);
    // Already started (past start, before end): too late to debrief ahead of it.
    expect(dueTouches({ startMs: now - 60_000, endMs: now + 3_600_000, windowKnown: true, committed: true, cancelled: false }, now)).toEqual([]);
    // Already ended.
    expect(dueTouches({ startMs: now - 7_200_000, endMs: now - 3_600_000, windowKnown: true, committed: true, cancelled: false }, now)).toEqual([]);
  });

  it("does not fire for a committed shift with no known start window (can't time a 2h-before debrief)", async () => {
    const { dueTouches } = await import("./workerPackets");
    const now = Date.now();
    expect(dueTouches({ startMs: null, endMs: null, windowKnown: false, committed: true, cancelled: false }, now)).toEqual([]);
  });

  it("does not fire earlier than 2 hours before start", async () => {
    const { dueTouches } = await import("./workerPackets");
    const now = Date.now();
    // 3h out: before the 2h window.
    expect(dueTouches({ startMs: now + 3 * 3_600_000, endMs: now + 6 * 3_600_000, windowKnown: true, committed: true, cancelled: false }, now)).toEqual([]);
    // Just over 2h out: still not due.
    expect(dueTouches({ startMs: now + 2 * 3_600_000 + 60_000, endMs: now + 5 * 3_600_000, windowKnown: true, committed: true, cancelled: false }, now)).toEqual([]);
  });

  it("fires the single refresher inside the 2h-before window", async () => {
    const { dueTouches } = await import("./workerPackets");
    const now = Date.now();
    // Exactly 2h out → due.
    expect(dueTouches({ startMs: now + 2 * 3_600_000, endMs: now + 5 * 3_600_000, windowKnown: true, committed: true, cancelled: false }, now)).toEqual(["refresher"]);
    // 30m out → still the single refresher (never a second touch).
    expect(dueTouches({ startMs: now + 30 * 60_000, endMs: now + 3 * 3_600_000, windowKnown: true, committed: true, cancelled: false }, now)).toEqual(["refresher"]);
  });
});

// ── Master-switch gate ───────────────────────────────────────────────────────────────────────────────
describe("runWorkerPacketsTick — master-switch gate (default OFF)", () => {
  it("is a healthy no-op that sends nothing when AUTO_PACKET_ENABLED is off", async () => {
    const m = await mods();
    delete process.env.AUTO_PACKET_ENABLED; // the owner has not opted in
    await committedShift(m, Date.now() + 2 * 3_600_000, Date.now() + 5 * 3_600_000).then((s) =>
      m.upsertAssignment({ shiftId: s.id, workerKind: "internal", connecteamUserId: 101, displayName: "Pat", role: "driver", state: "ASSIGNED" }),
    );
    const r = await m.runWorkerPacketsTick(new Date());
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/idle.*AUTO_PACKET_ENABLED off/);
    expect(vi.mocked(m.sms.sendSms)).not.toHaveBeenCalled();
  });

  it("also no-ops when SHIFT_COMMS_ENABLED or SMS_SEND_ENABLED is off", async () => {
    const m = await mods();
    process.env.SHIFT_COMMS_ENABLED = "false";
    let r = await m.runWorkerPacketsTick(new Date());
    expect(r.detail).toMatch(/SHIFT_COMMS_ENABLED off/);
    process.env.SHIFT_COMMS_ENABLED = "true";
    process.env.SMS_SEND_ENABLED = "false";
    r = await m.runWorkerPacketsTick(new Date());
    expect(r.detail).toMatch(/SMS_SEND_ENABLED off/);
    expect(vi.mocked(m.sms.sendSms)).not.toHaveBeenCalled();
  });
});

// ── Sending + strict idempotency ──────────────────────────────────────────────────────────────────────
describe("runWorkerPacketsTick — due sends + no re-send", () => {
  it("sends the single refresher once and NEVER re-sends on a second tick", async () => {
    const m = await mods();
    const now = new Date();
    // 2h before start → the single refresher is due.
    const shift = await committedShift(m, now.getTime() + 2 * 3_600_000, now.getTime() + 5 * 3_600_000);
    const aId = m.upsertAssignment({ shiftId: shift.id, workerKind: "internal", connecteamUserId: 101, displayName: "Pat", role: "driver", state: "ASSIGNED" });

    const r1 = await m.runWorkerPacketsTick(now);
    expect(r1.detail).toMatch(/1 sent/);
    expect(vi.mocked(m.sms.sendSms)).toHaveBeenCalledTimes(1);
    expect(m.hasShiftEvent(m.autoPacketChangeKey(aId, "refresher"))).toBe(true);
    // The other touches are manual-only — the auto trigger never fires them.
    expect(m.hasShiftEvent(m.autoPacketChangeKey(aId, "on_assign"))).toBe(false);
    expect(m.hasShiftEvent(m.autoPacketChangeKey(aId, "day_before"))).toBe(false);

    // Second tick (same clock): the refresher is already recorded → nothing re-sent.
    vi.mocked(m.sms.sendSms).mockClear();
    const r2 = await m.runWorkerPacketsTick(now);
    expect(r2.detail).toMatch(/0 sent/);
    expect(vi.mocked(m.sms.sendSms)).not.toHaveBeenCalled();
  });

  it("does not send earlier than 2 hours before the shift", async () => {
    const m = await mods();
    const now = new Date();
    // 4h out → outside the 2h window → nothing due yet.
    const shift = await committedShift(m, now.getTime() + 4 * 3_600_000, now.getTime() + 7 * 3_600_000);
    m.upsertAssignment({ shiftId: shift.id, workerKind: "internal", connecteamUserId: 101, displayName: "Pat", role: "driver", state: "ASSIGNED" });
    const r = await m.runWorkerPacketsTick(now);
    expect(r.detail).toMatch(/0 sent/);
    expect(vi.mocked(m.sms.sendSms)).not.toHaveBeenCalled();
  });

  it("does NOT debrief a non-route (warehouse prep) shift even inside the 2h window", async () => {
    const m = await mods();
    const now = new Date();
    const date = m.todayInOpsTz();
    // A committed PREP shift (no route) 1h out — owner rule: warehouse/non-route crew are not auto-debriefed.
    const prep = m.createShift({ date, role: "prep", headcount: 1, startTime: new Date(now.getTime() + 3_600_000).toISOString(), endTime: new Date(now.getTime() + 4 * 3_600_000).toISOString(), windowKnown: true });
    m.db.getDb().prepare("UPDATE staff_shifts SET connecteam_shift_id = ?, status = 'sent' WHERE id = ?").run(`CT-${prep.id}`, prep.id);
    m.upsertAssignment({ shiftId: prep.id, workerKind: "internal", connecteamUserId: 101, displayName: "Pat", role: "prep", state: "ASSIGNED" });
    const r = await m.runWorkerPacketsTick(now);
    expect(r.detail).toMatch(/0 sent/);
    expect(vi.mocked(m.sms.sendSms)).not.toHaveBeenCalled();
  });

  it("does not send for an uncommitted (draft) shift", async () => {
    const m = await mods();
    const now = new Date();
    const date = m.todayInOpsTz();
    const draft = m.createShift({ date, role: "driver", headcount: 1, routeId: "R-TEST-1", truckId: "T-TEST-1", startTime: new Date(now.getTime() + 2 * 3_600_000).toISOString(), endTime: new Date(now.getTime() + 5 * 3_600_000).toISOString(), windowKnown: true });
    m.upsertAssignment({ shiftId: draft.id, workerKind: "internal", connecteamUserId: 101, displayName: "Pat", role: "driver", state: "ASSIGNED" });
    const r = await m.runWorkerPacketsTick(now);
    expect(r.detail).toMatch(/0 sent/);
    expect(vi.mocked(m.sms.sendSms)).not.toHaveBeenCalled();
  });
});

// ── Instawork: skipped WITHOUT a captured phone, texted WITH one ────────────────────────────────────────
describe("runWorkerPacketsTick — Instawork temps: skipped until their phone is captured", () => {
  it("skips an Instawork worker with no captured phone, and records no sent-touch for them", async () => {
    const m = await mods();
    const now = new Date();
    const shift = await committedShift(m, now.getTime() + 2 * 3_600_000, now.getTime() + 5 * 3_600_000);
    const iwId = m.upsertAssignment({ shiftId: shift.id, workerKind: "instawork", instaworkWorker: "Jamie Lee", displayName: "Jamie Lee", role: "field", state: "ASSIGNED" });

    const r = await m.runWorkerPacketsTick(now);
    expect(vi.mocked(m.sms.sendSms)).not.toHaveBeenCalled();
    expect(r.detail).toMatch(/skipped/);
    // No idempotency/sent row was written for the temp — so they are NOT silently marked debriefed.
    expect(m.hasShiftEvent(m.autoPacketChangeKey(iwId, "refresher"))).toBe(false);
  });

  it("DOES text an Instawork worker once their booked-pro phone has been captured", async () => {
    const m = await mods();
    const { saveInstaworkContacts } = await import("@/lib/instawork/contacts");
    // The Auto-Pull extension captured this booked pro's phone from the timesheet view (synthetic fixture).
    saveInstaworkContacts([{ workerId: "7000001", name: "Jordan Rivera", phone: "(301) 555-0147", capturedAt: new Date().toISOString() }]);

    const now = new Date();
    const shift = await committedShift(m, now.getTime() + 2 * 3_600_000, now.getTime() + 5 * 3_600_000);
    const iwId = m.upsertAssignment({ shiftId: shift.id, workerKind: "instawork", instaworkWorker: "Jordan Rivera", displayName: "Jordan Rivera", role: "field", state: "ASSIGNED" });

    const r = await m.runWorkerPacketsTick(now);
    // 2h out → the single refresher is due → one real send to the CAPTURED number (matched by name).
    expect(vi.mocked(m.sms.sendSms)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(m.sms.sendSms).mock.calls[0][0]).toBe("(301) 555-0147");
    expect(r.detail).toMatch(/1 sent/);
    expect(m.hasShiftEvent(m.autoPacketChangeKey(iwId, "refresher"))).toBe(true);
  });
});
