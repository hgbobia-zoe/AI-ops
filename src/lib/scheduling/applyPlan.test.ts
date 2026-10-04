import { describe, it, expect } from "vitest";
import { derivePlanWrites } from "./applyPlan";
import type { StaffingPlan, PlannedAssignment } from "./optimize";

function seat(p: Partial<PlannedAssignment> & { shiftId: string; kind: "internal" | "temp" }): PlannedAssignment {
  return {
    routeId: p.routeId ?? p.shiftId,
    role: p.role ?? "field",
    userId: p.kind === "internal" ? (p.userId ?? 1) : null,
    name: p.name ?? (p.kind === "internal" ? "Worker" : "Temp (field)"),
    hours: p.hours ?? 8,
    whyThisRoute: p.whyThisRoute ?? "",
    whyTemp: p.kind === "temp" ? (p.whyTemp ?? "Internal crew exhausted for this window") : null,
    wasCommitted: p.wasCommitted ?? false,
    moved: p.moved ?? false,
    fromRouteId: p.fromRouteId ?? null,
    ...p,
  } as PlannedAssignment;
}

function plan(assignments: PlannedAssignment[]): StaffingPlan {
  return {
    date: "2026-10-04",
    assignments,
    currentTempHours: null,
    planTempHours: null,
    currentTempCount: 0,
    planTempCount: 0,
    tempHoursSaved: null,
    tempCountSaved: 0,
    betterThanCurrent: true,
    alreadyOptimal: false,
    note: "",
  };
}

describe("derivePlanWrites", () => {
  it("groups internal picks per shift and sums temp seats with reasons", () => {
    const writes = derivePlanWrites(
      plan([
        seat({ shiftId: "SH-A", kind: "internal", userId: 11, hours: 10 }),
        seat({ shiftId: "SH-A", kind: "internal", userId: 12, hours: 10, moved: true, fromRouteId: "SH-B" }),
        seat({ shiftId: "SH-B", kind: "temp", hours: 2, whyTemp: "Internal crew exhausted for this window" }),
        seat({ shiftId: "SH-B", kind: "temp", hours: 2 }),
      ]),
    );
    expect(writes).toHaveLength(2);
    const a = writes.find((w) => w.shiftId === "SH-A")!;
    expect(a.internalUserIds).toEqual([11, 12]);
    expect(a.tempCount).toBe(0);
    expect(a.internal.find((s) => s.userId === 12)?.moved).toBe(true);

    const b = writes.find((w) => w.shiftId === "SH-B")!;
    expect(b.internalUserIds).toEqual([]);
    expect(b.tempCount).toBe(2);
    expect(b.tempHours).toBe(4);
    expect(b.tempReason).toBe("internal_exhausted");
    expect(b.routeReason).toBe("shortest_eligible_route");
  });

  it("maps a 'no internal qualified' temp reason to its enum, and null temp hours when a window is unknown", () => {
    const writes = derivePlanWrites(
      plan([
        seat({ shiftId: "SH-C", kind: "temp", hours: null, whyTemp: "No internal crew qualified for this role" }),
      ]),
    );
    const c = writes[0];
    expect(c.tempReason).toBe("no_internal_qualified");
    expect(c.tempHours).toBeNull();
  });

  it("is stable-ordered by shiftId", () => {
    const writes = derivePlanWrites(
      plan([seat({ shiftId: "SH-Z", kind: "internal", userId: 1 }), seat({ shiftId: "SH-A", kind: "internal", userId: 2 })]),
    );
    expect(writes.map((w) => w.shiftId)).toEqual(["SH-A", "SH-Z"]);
  });
});
