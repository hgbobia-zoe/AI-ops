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

/** Create a COMMITTED (provisioned) prep shift today with a given window, and return it. No route, so the
 *  pre-check gate is a no-op and we need no route/vehicle fixtures. */
async function committedShift(m: Awaited<ReturnType<typeof mods>>, startMs: number | null, endMs: number | null) {
  const date = m.todayInOpsTz();
  const s = m.createShift({
    date,
    role: "prep",
    headcount: 1,
    startTime: startMs != null ? new Date(startMs).toISOString() : null,
    endTime: endMs != null ? new Date(endMs).toISOString() : null,
    windowKnown: startMs != null,
  });
  // Mark committed: set the Connecteam linkage + 'sent' status (what shiftCommitted() reads).
  m.db.getDb().prepare("UPDATE staff_shifts SET connecteam_shift_id = ?, status = 'sent' WHERE id = ?").run(`CT-${s.id}`, s.id);
  return m.getShiftById(s.id)!;
}

// ── Pure due-window logic ────────────────────────────────────────────────────────────────────────────
describe("dueTouches (pure)", () => {
  it("returns nothing for a cancelled, uncommitted, or already-ended shift", async () => {
    const { dueTouches } = await import("./workerPackets");
    const now = Date.now();
    const base = { startMs: now + 3_600_000, endMs: now + 7_200_000, windowKnown: true, committed: true, cancelled: false };
    expect(dueTouches({ ...base, cancelled: true }, now)).toEqual([]);
    expect(dueTouches({ ...base, committed: false }, now)).toEqual([]);
    expect(dueTouches({ startMs: now - 7_200_000, endMs: now - 3_600_000, windowKnown: true, committed: true, cancelled: false }, now)).toEqual([]);
  });

  it("fires only on_assign for a committed shift well before start / with unknown window", async () => {
    const { dueTouches } = await import("./workerPackets");
    const now = Date.now();
    // 3 days out: before the day_before (18h) and refresher (1h) windows.
    expect(dueTouches({ startMs: now + 3 * 86_400_000, endMs: now + 3 * 86_400_000 + 7_200_000, windowKnown: true, committed: true, cancelled: false }, now)).toEqual(["on_assign"]);
    // Unknown window → only on_assign can ever be due.
    expect(dueTouches({ startMs: null, endMs: null, windowKnown: false, committed: true, cancelled: false }, now)).toEqual(["on_assign"]);
  });

  it("adds day_before inside its lead window, and refresher near start", async () => {
    const { dueTouches } = await import("./workerPackets");
    const now = Date.now();
    // 2h before start: day_before window open (18h..1h), refresher not yet (opens 1h before).
    const twoHoursOut = { startMs: now + 2 * 3_600_000, endMs: now + 5 * 3_600_000, windowKnown: true, committed: true, cancelled: false };
    expect(dueTouches(twoHoursOut, now).sort()).toEqual(["day_before", "on_assign"]);
    // 30m before start: day_before window closed (floor 1h), refresher open.
    const halfHourOut = { startMs: now + 30 * 60_000, endMs: now + 3 * 3_600_000, windowKnown: true, committed: true, cancelled: false };
    expect(dueTouches(halfHourOut, now).sort()).toEqual(["on_assign", "refresher"]);
  });
});

// ── Master-switch gate ───────────────────────────────────────────────────────────────────────────────
describe("runWorkerPacketsTick — master-switch gate (default OFF)", () => {
  it("is a healthy no-op that sends nothing when AUTO_PACKET_ENABLED is off", async () => {
    const m = await mods();
    delete process.env.AUTO_PACKET_ENABLED; // the owner has not opted in
    await committedShift(m, Date.now() + 2 * 3_600_000, Date.now() + 5 * 3_600_000).then((s) =>
      m.upsertAssignment({ shiftId: s.id, workerKind: "internal", connecteamUserId: 101, displayName: "Pat", role: "prep", state: "ASSIGNED" }),
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
  it("sends each due touch once and NEVER re-sends on a second tick", async () => {
    const m = await mods();
    const now = new Date();
    // 2h before start → on_assign + day_before are due (refresher not yet).
    const shift = await committedShift(m, now.getTime() + 2 * 3_600_000, now.getTime() + 5 * 3_600_000);
    const aId = m.upsertAssignment({ shiftId: shift.id, workerKind: "internal", connecteamUserId: 101, displayName: "Pat", role: "prep", state: "ASSIGNED" });

    const r1 = await m.runWorkerPacketsTick(now);
    expect(r1.detail).toMatch(/2 sent/);
    expect(vi.mocked(m.sms.sendSms)).toHaveBeenCalledTimes(2);
    expect(m.hasShiftEvent(m.autoPacketChangeKey(aId, "on_assign"))).toBe(true);
    expect(m.hasShiftEvent(m.autoPacketChangeKey(aId, "day_before"))).toBe(true);
    expect(m.hasShiftEvent(m.autoPacketChangeKey(aId, "refresher"))).toBe(false);

    // Second tick (same clock): both touches already recorded → nothing re-sent.
    vi.mocked(m.sms.sendSms).mockClear();
    const r2 = await m.runWorkerPacketsTick(now);
    expect(r2.detail).toMatch(/0 sent/);
    expect(vi.mocked(m.sms.sendSms)).not.toHaveBeenCalled();
  });

  it("does not send for an uncommitted (draft) shift", async () => {
    const m = await mods();
    const now = new Date();
    const date = m.todayInOpsTz();
    const draft = m.createShift({ date, role: "prep", headcount: 1, startTime: new Date(now.getTime() + 2 * 3_600_000).toISOString(), endTime: new Date(now.getTime() + 5 * 3_600_000).toISOString(), windowKnown: true });
    m.upsertAssignment({ shiftId: draft.id, workerKind: "internal", connecteamUserId: 101, displayName: "Pat", role: "prep", state: "ASSIGNED" });
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
    const iwId = m.upsertAssignment({ shiftId: shift.id, workerKind: "instawork", instaworkWorker: "Jamie Lee", displayName: "Jamie Lee", role: "prep", state: "ASSIGNED" });

    const r = await m.runWorkerPacketsTick(now);
    expect(vi.mocked(m.sms.sendSms)).not.toHaveBeenCalled();
    expect(r.detail).toMatch(/skipped/);
    // No idempotency/sent row was written for the temp — so they are NOT silently marked debriefed.
    expect(m.hasShiftEvent(m.autoPacketChangeKey(iwId, "on_assign"))).toBe(false);
  });

  it("DOES text an Instawork worker once their booked-pro phone has been captured", async () => {
    const m = await mods();
    const { saveInstaworkContacts } = await import("@/lib/instawork/contacts");
    // The Auto-Pull extension captured this booked pro's phone from the timesheet view (synthetic fixture).
    saveInstaworkContacts([{ workerId: "7000001", name: "Jordan Rivera", phone: "(301) 555-0147", capturedAt: new Date().toISOString() }]);

    const now = new Date();
    const shift = await committedShift(m, now.getTime() + 2 * 3_600_000, now.getTime() + 5 * 3_600_000);
    const iwId = m.upsertAssignment({ shiftId: shift.id, workerKind: "instawork", instaworkWorker: "Jordan Rivera", displayName: "Jordan Rivera", role: "prep", state: "ASSIGNED" });

    const r = await m.runWorkerPacketsTick(now);
    // 2h out → on_assign + day_before due → real sends to the CAPTURED number (matched by name).
    expect(vi.mocked(m.sms.sendSms)).toHaveBeenCalled();
    expect(vi.mocked(m.sms.sendSms).mock.calls[0][0]).toBe("(301) 555-0147");
    expect(r.detail).toMatch(/sent/);
    expect(m.hasShiftEvent(m.autoPacketChangeKey(iwId, "on_assign"))).toBe(true);
  });
});
