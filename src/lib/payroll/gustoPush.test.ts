import { describe, it, expect } from "vitest";
import {
  splitOvertime,
  isPushable,
  buildPushEntries,
  buildAutoSaveWorkedHoursVariables,
  matchEntriesToEmployees,
  hoursAlreadyMatch,
  type EmployeeIdMapEntry,
} from "./gustoPush";
import type { ReviewWorker, UnifiedWorker, WorkerType } from "./types";

// ── test fixtures ───────────────────────────────────────────────────────────────────────────────────
function rw(p: Partial<ReviewWorker>): ReviewWorker {
  return {
    key: p.key ?? "ct:1",
    name: p.name ?? "Worker",
    workerType: (p.workerType ?? "EMPLOYEE") as WorkerType,
    hours: p.hours ?? null,
    payRate: p.payRate ?? null,
    currency: p.currency ?? "USD",
    estPay: p.estPay ?? null,
    mappingStatus: p.mappingStatus ?? "MATCHED",
    status: p.status ?? "READY",
    issues: p.issues ?? [],
  };
}
function uw(p: Partial<UnifiedWorker>): UnifiedWorker {
  return {
    key: p.key ?? "ct:1", recordId: null, name: p.name ?? "Worker", email: null,
    workerType: (p.workerType ?? "EMPLOYEE") as WorkerType, typeInferred: false, country: null,
    connecteamUserId: 1, instaworkWorker: null, inConnecteam: true, gustoId: p.gustoId ?? null,
    gustoMapped: Boolean(p.gustoId), payType: "hourly", payRate: p.payRate ?? null, currency: "USD",
    active: true, persisted: true, periodHours: p.periodHours ?? null,
    mappingStatus: p.gustoId ? "MATCHED" : "UNMATCHED",
  };
}

describe("splitOvertime", () => {
  it("all regular at or below the threshold", () => {
    expect(splitOvertime(40, 40)).toEqual({ regular: 40, overtime: 0 });
    expect(splitOvertime(25.33, 40)).toEqual({ regular: 25.33, overtime: 0 });
  });
  it("splits above the threshold", () => {
    expect(splitOvertime(52, 40)).toEqual({ regular: 40, overtime: 12 });
    expect(splitOvertime(46.5, 40)).toEqual({ regular: 40, overtime: 6.5 });
  });
  it("honors a custom threshold and clamps negatives", () => {
    expect(splitOvertime(50, 45)).toEqual({ regular: 45, overtime: 5 });
    expect(splitOvertime(-3, 40)).toEqual({ regular: 0, overtime: 0 });
  });
  it("rounds to 2dp (no float drift)", () => {
    expect(splitOvertime(40.1, 40)).toEqual({ regular: 40, overtime: 0.1 });
  });
});

describe("isPushable", () => {
  it("READY + mapped + hours → pushable", () => {
    expect(isPushable(rw({ status: "READY", hours: 20 }), "g1").ok).toBe(true);
  });
  it("REQUIRES_REVIEW (overtime) is still pushable", () => {
    expect(isPushable(rw({ status: "REQUIRES_REVIEW", hours: 52 }), "g1").ok).toBe(true);
  });
  it("BLOCKED is never pushable", () => {
    const r = isPushable(rw({ status: "BLOCKED", hours: 20 }), "g1");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked/i);
  });
  it("no gusto mapping is never pushable (even if not blocked)", () => {
    const r = isPushable(rw({ status: "READY", hours: 20 }), null);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/mapping/i);
  });
  it("zero/null hours are skipped", () => {
    expect(isPushable(rw({ status: "READY", hours: 0 }), "g1").ok).toBe(false);
    expect(isPushable(rw({ status: "READY", hours: null }), "g1").ok).toBe(false);
  });
});

describe("buildPushEntries", () => {
  it("includes only mapped + non-blocked workers with hours, with the OT split applied", () => {
    const review = [
      rw({ key: "ct:1", name: "Ann", status: "READY", hours: 25 }),
      rw({ key: "ct:2", name: "Ben", status: "REQUIRES_REVIEW", hours: 52 }), // overtime → split
      rw({ key: "ct:3", name: "Cara", status: "BLOCKED", hours: 30 }), // blocked → skip
      rw({ key: "ct:4", name: "Dan", status: "READY", hours: 10 }), // not mapped → skip
      rw({ key: "ct:5", name: "Eve", status: "READY", hours: 0 }), // no hours → skip
    ];
    const unified = [
      uw({ key: "ct:1", gustoId: "g1" }),
      uw({ key: "ct:2", gustoId: "g2" }),
      uw({ key: "ct:3", gustoId: "g3" }),
      uw({ key: "ct:4", gustoId: null }),
      uw({ key: "ct:5", gustoId: "g5" }),
    ];
    const r = buildPushEntries(review, unified, 40);
    expect(r.entries).toEqual([
      { gustoMemberId: "g1", name: "Ann", regularHours: 25, overtimeHours: 0, doubleOvertimeHours: 0 },
      { gustoMemberId: "g2", name: "Ben", regularHours: 40, overtimeHours: 12, doubleOvertimeHours: 0 },
    ]);
    expect(r.mappedCount).toBe(2);
    expect(r.totalRegular).toBe(65);
    expect(r.totalOvertime).toBe(12);
    // everyone excluded is reported, with a reason
    expect(r.skipped.map((s) => s.name).sort()).toEqual(["Cara", "Dan", "Eve"]);
    expect(r.skipped.find((s) => s.name === "Cara")!.reason).toMatch(/blocked/i);
    expect(r.skipped.find((s) => s.name === "Dan")!.reason).toMatch(/mapping/i);
  });

  it("never pushes a blocked worker even when a gusto_id is present", () => {
    const review = [rw({ key: "ct:1", name: "Ann", status: "BLOCKED", hours: 30 })];
    const unified = [uw({ key: "ct:1", gustoId: "g1" })];
    const r = buildPushEntries(review, unified, 40);
    expect(r.entries).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });
});

describe("buildAutoSaveWorkedHoursVariables", () => {
  it("matches the captured spec shape exactly", () => {
    const vars = buildAutoSaveWorkedHoursVariables(
      "emp-uuid",
      { employeeJobUuid: "job-uuid", regularHours: 40, overtimeHours: 12, doubleOvertimeHours: 0 },
      { payrollActivitySessionId: "sess-1", uniqueIdentifier: "uid-1" },
    );
    expect(vars).toEqual({
      employeeUuid: "emp-uuid",
      input: {
        payrollActivitySessionId: "sess-1",
        uniqueIdentifier: "uid-1",
        workedHours: [
          {
            employeeUuid: "emp-uuid",
            workedHours: [
              {
                employeeJobUuid: "job-uuid",
                regularHours: 40,
                overtimeHours: 12,
                doubleOvertimeHours: 0,
                missedBreakHours: "0.0",
              },
            ],
          },
        ],
      },
    });
  });
});

describe("matchEntriesToEmployees", () => {
  it("matches by companyMemberUuid == gustoMemberId and reports unmatched", () => {
    const entries = [
      { gustoMemberId: "g1", name: "Ann", regularHours: 10, overtimeHours: 0, doubleOvertimeHours: 0 },
      { gustoMemberId: "gX", name: "Ghost", regularHours: 10, overtimeHours: 0, doubleOvertimeHours: 0 },
    ];
    const map = new Map<string, EmployeeIdMapEntry>([["g1", { employeeUuid: "e1", employeeJobUuid: "j1" }]]);
    const r = matchEntriesToEmployees(entries, map);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].ids).toEqual({ employeeUuid: "e1", employeeJobUuid: "j1" });
    expect(r.unmatched.map((e) => e.name)).toEqual(["Ghost"]);
  });
});

describe("hoursAlreadyMatch (idempotency)", () => {
  const target = { regularHours: 40, overtimeHours: 12, doubleOvertimeHours: 0 };
  it("true when current equals target (skip the write)", () => {
    expect(hoursAlreadyMatch(target, { regularHours: 40, overtimeHours: 12, doubleOvertimeHours: 0 })).toBe(true);
  });
  it("false when current differs or is absent", () => {
    expect(hoursAlreadyMatch(target, { regularHours: 40, overtimeHours: 0, doubleOvertimeHours: 0 })).toBe(false);
    expect(hoursAlreadyMatch(target, null)).toBe(false);
  });
  it("tolerates tiny float drift", () => {
    expect(hoursAlreadyMatch(target, { regularHours: 40.0000001, overtimeHours: 12, doubleOvertimeHours: 0 })).toBe(true);
  });
});
