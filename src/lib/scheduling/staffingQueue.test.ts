import { describe, it, expect } from "vitest";
import { buildStaffingQueue, type StaffingQueueInput } from "./staffingQueue";
import type { RoutePreCheck } from "./preCheck";
import type { ShiftException } from "./exceptions";
import type { SyncConflictView } from "./needsReview";

function preCheck(routeId: string, overrides: Partial<RoutePreCheck> = {}): RoutePreCheck {
  return {
    requiredByRole: { driver: 1, field: 1 },
    assignedByRole: { driver: 0, field: 0 },
    gapByRole: { driver: 1, field: 1 },
    totalGap: 2,
    nobody: true,
    status: "gap",
    reason: "No crew assigned in the app",
    routeId,
    date: "2026-10-15",
    truckId: `T-${routeId}`,
    truckName: `Truck ${routeId}`,
    stopCount: 3,
    customerCount: 2,
    connecteamCandidates: [],
    connecteamReachable: true,
    ...overrides,
  };
}

function exc(shiftId: string, code: ShiftException["code"], severity: ShiftException["severity"], routeId: string | null = null): ShiftException {
  return {
    signature: `${shiftId}:${code}`,
    shiftId,
    routeId,
    code,
    severity,
    title: code,
    detail: `${code} detail`,
    fixLabel: "Fix",
    rank: severity === "RED" ? 0 : 1,
  };
}

const EMPTY: StaffingQueueInput = {
  preChecks: [],
  exceptions: [],
  conflicts: [],
  scheduledUnrouted: [],
  routeMeta: {},
  shiftMeta: {},
};

describe("buildStaffingQueue", () => {
  it("orders by category first, then severity, then time", () => {
    const input: StaffingQueueInput = {
      ...EMPTY,
      preChecks: [preCheck("R1", { nobody: false, status: "gap" })], // cat 1, attention
      exceptions: [
        exc("s-sync", "unconfirmed", "RED"), // cat 3, critical
        exc("s-conf", "assignee_unavailable", "RED"), // cat 2, critical
        exc("s-oth", "no_window", "YELLOW"), // cat 6
        exc("s-pub", "not_published", "YELLOW"), // cat 4
      ],
      conflicts: [{ shiftId: "s-syncconf", routeId: null, syncNote: "both edited" } as SyncConflictView], // cat 5
    };
    const q = buildStaffingQueue(input);
    expect(q.map((i) => i.category)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("marks a nobody pre-check as critical and a partial gap as attention", () => {
    const q = buildStaffingQueue({
      ...EMPTY,
      preChecks: [preCheck("R1", { nobody: true }), preCheck("R2", { nobody: false, status: "gap" })],
    });
    const byRoute = Object.fromEntries(q.map((i) => [i.id, i.severity]));
    expect(byRoute["precheck:R1"]).toBe("critical");
    expect(byRoute["precheck:R2"]).toBe("attention");
  });

  it("dedupes an understaffed shift exception against its route's pre-check gap", () => {
    const q = buildStaffingQueue({
      ...EMPTY,
      preChecks: [preCheck("R1")],
      exceptions: [exc("s1", "understaffed", "RED", "R1")],
    });
    // Only the pre-check row survives for R1 — no duplicate understaffed row.
    expect(q.filter((i) => i.category === 1)).toHaveLength(1);
    expect(q[0].id).toBe("precheck:R1");
  });

  it("keeps an understaffed exception that has no matching pre-check (e.g. prep)", () => {
    const q = buildStaffingQueue({
      ...EMPTY,
      exceptions: [exc("prep1", "understaffed", "RED", null)],
    });
    expect(q).toHaveLength(1);
    expect(q[0].category).toBe(1);
    expect(q[0].target).toBe("board");
  });

  it("places scheduled-but-unrouted candidates in category 1 pointing at their prompt", () => {
    const q = buildStaffingQueue({
      ...EMPTY,
      scheduledUnrouted: [{ userId: 7, name: "Pat", roleLabel: "Driver", windowLabel: "8a - 2p", startMs: 1000 }],
    });
    expect(q[0].category).toBe(1);
    expect(q[0].target).toBe("scheduled-to-route");
    expect(q[0].problem).toContain("Pat");
  });

  it("returns an empty queue when nothing is wrong", () => {
    expect(buildStaffingQueue(EMPTY)).toEqual([]);
    // an ok pre-check contributes nothing
    expect(buildStaffingQueue({ ...EMPTY, preChecks: [preCheck("R1", { status: "ok", nobody: false, totalGap: 0 })] })).toEqual([]);
  });

  it("uses route/shift meta for labels, window and the time tie-break", () => {
    const q = buildStaffingQueue({
      ...EMPTY,
      preChecks: [preCheck("R1", { nobody: false, status: "gap" }), preCheck("R2", { nobody: false, status: "gap" })],
      routeMeta: {
        R1: { label: "Box Truck 1", windowLabel: "9a - 3p", startMs: 2000 },
        R2: { label: "Box Truck 2", windowLabel: "7a - 1p", startMs: 1000 },
      },
    });
    // Same category + severity → earlier window first.
    expect(q.map((i) => i.routeLabel)).toEqual(["Box Truck 2", "Box Truck 1"]);
    expect(q[0].windowLabel).toBe("7a - 1p");
  });
});
