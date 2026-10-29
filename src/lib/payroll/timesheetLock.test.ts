import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayPeriod } from "./types";

// Orchestration for "approve payroll in the app → finalize (lock) the worked days in Connecteam". Connecteam
// + the SQLite store are mocked so these tests are pure logic, never a live write. We assert worked-date
// selection (only days with hours), the per-worker outcome classification (LOCKED / FAILED / NA), idempotent
// recording, and the unlock path tolerating a 409.

const { mockConnecteam, mockStore } = vi.hoisted(() => ({
  mockConnecteam: {
    connecteamConfigured: vi.fn(() => true),
    getPrimaryTimeClockId: vi.fn(async () => 77 as number | null),
    getTimesheetDetail: vi.fn(),
    lockUserDays: vi.fn(),
  },
  mockStore: {
    upsertTimesheetLock: vi.fn(),
    listTimesheetLocks: vi.fn(),
  },
}));

vi.mock("@/lib/connecteam", () => mockConnecteam);
vi.mock("./store", () => mockStore);

import { finalizeApprovedTimesheets, unlockApprovedTimesheets } from "./timesheetLock";

const PERIOD: PayPeriod = { start: "2026-10-19", end: "2026-10-25", label: "Oct 19 – Oct 25" };

function tsDetail(byUser: Record<number, string[]>, ok = true) {
  const m = new Map<number, { workedDates: string[] }>();
  for (const [uid, dates] of Object.entries(byUser)) m.set(Number(uid), { workedDates: dates });
  return { ok, approvalFieldSeen: false, byUser: m };
}

beforeEach(() => {
  mockConnecteam.connecteamConfigured.mockReturnValue(true);
  mockConnecteam.getPrimaryTimeClockId.mockResolvedValue(77);
  mockConnecteam.lockUserDays.mockResolvedValue({ ok: true, status: 200, dates: [] });
  mockStore.listTimesheetLocks.mockReturnValue(new Map());
});
afterEach(() => vi.clearAllMocks());

describe("finalizeApprovedTimesheets", () => {
  it("locks each worker's WORKED days (from the timesheet) and records LOCKED", async () => {
    mockConnecteam.getTimesheetDetail.mockResolvedValue(tsDetail({ 1: ["2026-10-20", "2026-10-21"] }));
    mockConnecteam.lockUserDays.mockResolvedValue({ ok: true, status: 200, dates: ["2026-10-20", "2026-10-21"] });
    const r = await finalizeApprovedTimesheets(PERIOD, [{ workerKey: "ct:1", name: "A", connecteamUserId: 1 }], "Lisa");
    expect(r.ok).toBe(true);
    expect(r.locked).toBe(1);
    expect(mockConnecteam.lockUserDays).toHaveBeenCalledWith(77, 1, ["2026-10-20", "2026-10-21"], true);
    expect(mockStore.upsertTimesheetLock).toHaveBeenCalledWith(expect.objectContaining({ workerKey: "ct:1", lockStatus: "LOCKED", lockedDates: ["2026-10-20", "2026-10-21"] }));
  });

  it("records NA (no Connecteam call) when the worker has no worked days", async () => {
    mockConnecteam.getTimesheetDetail.mockResolvedValue(tsDetail({ 1: [] }));
    const r = await finalizeApprovedTimesheets(PERIOD, [{ workerKey: "ct:1", name: "A", connecteamUserId: 1 }], "Lisa");
    expect(r.na).toBe(1);
    expect(r.locked).toBe(0);
    expect(mockConnecteam.lockUserDays).not.toHaveBeenCalled();
    expect(mockStore.upsertTimesheetLock).toHaveBeenCalledWith(expect.objectContaining({ workerKey: "ct:1", lockStatus: "NA" }));
  });

  it("records NA for a worker with no Connecteam id (approved in Zoe only)", async () => {
    mockConnecteam.getTimesheetDetail.mockResolvedValue(tsDetail({}));
    const r = await finalizeApprovedTimesheets(PERIOD, [{ workerKey: "hw:x", name: "Temp", connecteamUserId: null }], "Lisa");
    expect(r.na).toBe(1);
    expect(mockConnecteam.lockUserDays).not.toHaveBeenCalled();
  });

  it("records FAILED (never fakes success) when the Connecteam lock fails", async () => {
    mockConnecteam.getTimesheetDetail.mockResolvedValue(tsDetail({ 1: ["2026-10-20"] }));
    mockConnecteam.lockUserDays.mockResolvedValue({ ok: false, status: 403, error: "forbidden", dates: ["2026-10-20"] });
    const r = await finalizeApprovedTimesheets(PERIOD, [{ workerKey: "ct:1", name: "A", connecteamUserId: 1 }], "Lisa");
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(1);
    expect(mockStore.upsertTimesheetLock).toHaveBeenCalledWith(expect.objectContaining({ workerKey: "ct:1", lockStatus: "FAILED" }));
  });

  it("records FAILED when Connecteam is unreachable (approved in Zoe, finalize deferred)", async () => {
    mockConnecteam.getTimesheetDetail.mockResolvedValue(tsDetail({}, false));
    const r = await finalizeApprovedTimesheets(PERIOD, [{ workerKey: "ct:1", name: "A", connecteamUserId: 1 }], "Lisa");
    expect(r.failed).toBe(1);
    expect(mockConnecteam.lockUserDays).not.toHaveBeenCalled();
  });

  it("records NA for everyone (no call) when Connecteam is not configured", async () => {
    mockConnecteam.connecteamConfigured.mockReturnValue(false);
    const r = await finalizeApprovedTimesheets(PERIOD, [{ workerKey: "ct:1", name: "A", connecteamUserId: 1 }], "Lisa");
    expect(r.na).toBe(1);
    expect(mockConnecteam.getTimesheetDetail).not.toHaveBeenCalled();
    expect(mockConnecteam.lockUserDays).not.toHaveBeenCalled();
  });

  it("is idempotent — re-finalizing the same worker just upserts again (Connecteam re-lock is a safe no-op)", async () => {
    mockConnecteam.getTimesheetDetail.mockResolvedValue(tsDetail({ 1: ["2026-10-20"] }));
    mockConnecteam.lockUserDays.mockResolvedValue({ ok: true, status: 200, dates: ["2026-10-20"] });
    await finalizeApprovedTimesheets(PERIOD, [{ workerKey: "ct:1", name: "A", connecteamUserId: 1 }], "Lisa");
    await finalizeApprovedTimesheets(PERIOD, [{ workerKey: "ct:1", name: "A", connecteamUserId: 1 }], "Lisa");
    expect(mockStore.upsertTimesheetLock).toHaveBeenCalledTimes(2);
    expect(mockStore.upsertTimesheetLock).toHaveBeenLastCalledWith(expect.objectContaining({ workerKey: "ct:1", lockStatus: "LOCKED" }));
  });
});

describe("unlockApprovedTimesheets", () => {
  it("unlocks locked days and marks the record UNLOCKED (Zoe approval withdrawn)", async () => {
    mockStore.listTimesheetLocks.mockReturnValue(new Map([
      ["ct:1", { workerKey: "ct:1", connecteamUserId: 1, approvedBy: "Lisa", approvedAt: "x", lockStatus: "LOCKED", lockDetail: null, lockedDates: ["2026-10-20"], updatedAt: "x" }],
    ]));
    mockConnecteam.lockUserDays.mockResolvedValue({ ok: true, status: 200, dates: ["2026-10-20"] });
    const r = await unlockApprovedTimesheets(PERIOD);
    expect(r.ok).toBe(true);
    expect(r.unlocked).toBe(1);
    expect(mockConnecteam.lockUserDays).toHaveBeenCalledWith(77, 1, ["2026-10-20"], false);
    expect(mockStore.upsertTimesheetLock).toHaveBeenCalledWith(expect.objectContaining({ workerKey: "ct:1", lockStatus: "UNLOCKED" }));
  });

  it("tolerates a 409 (DAYS_IN_APPROVED_PERIOD): withdraws the Zoe approval but reports the conflict", async () => {
    mockStore.listTimesheetLocks.mockReturnValue(new Map([
      ["ct:1", { workerKey: "ct:1", connecteamUserId: 1, approvedBy: "Lisa", approvedAt: "x", lockStatus: "LOCKED", lockDetail: null, lockedDates: ["2026-10-20"], updatedAt: "x" }],
    ]));
    mockConnecteam.lockUserDays.mockResolvedValue({ ok: false, status: 409, code: "DAYS_IN_APPROVED_PERIOD", dates: ["2026-10-20"] });
    const r = await unlockApprovedTimesheets(PERIOD);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toBe(1);
    expect(r.unlocked).toBe(1); // the Zoe marker is still withdrawn
    expect(mockStore.upsertTimesheetLock).toHaveBeenCalledWith(expect.objectContaining({ workerKey: "ct:1", lockStatus: "UNLOCKED" }));
  });

  it("skips records already UNLOCKED", async () => {
    mockStore.listTimesheetLocks.mockReturnValue(new Map([
      ["ct:1", { workerKey: "ct:1", connecteamUserId: 1, approvedBy: "Lisa", approvedAt: "x", lockStatus: "UNLOCKED", lockDetail: null, lockedDates: ["2026-10-20"], updatedAt: "x" }],
    ]));
    const r = await unlockApprovedTimesheets(PERIOD);
    expect(r.unlocked).toBe(0);
    expect(mockConnecteam.lockUserDays).not.toHaveBeenCalled();
  });
});
