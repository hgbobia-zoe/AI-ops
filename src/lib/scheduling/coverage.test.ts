import { describe, it, expect } from "vitest";
import { computeCoverage } from "./coverage";
import type { StaffShift } from "./types";

function shift(p: Partial<StaffShift> & { id: string; role: StaffShift["role"] }): StaffShift {
  return {
    date: "2026-09-30",
    headcount: 1,
    startTime: null,
    endTime: null,
    windowKnown: false,
    location: null,
    routeId: null,
    truckId: null,
    eventLabel: null,
    reasons: [],
    notes: null,
    source: "derived",
    status: "draft",
    assignees: [],
    instaworkHeadcount: 0,
    payRate: null,
    connecteamShiftId: null,
    connecteamSchedulerId: null,
    connecteamPublishedAt: null,
    instaworkGigId: null,
    instaworkPostedAt: null,
    lifecycleState: null,
    supervisorUserId: null,
    reportLocation: null,
    reportTime: null,
    equipment: [],
    instructions: null,
    createdAt: "",
    updatedAt: "",
    ...p,
  };
}

// The refinement (doc §2.2): coverage counts EXPLICIT route assignments only. A Connecteam work shift is
// NOT a route assignment, so a scheduled-but-unassigned worker is no longer credited as "covering" a seat
// — the gap stays honest, and that worker surfaces as a PREFERRED candidate in recommend/optimize instead.
describe("computeCoverage (explicit assignments only — no Connecteam-schedule credit)", () => {
  it("counts an explicit route assignee as covered", () => {
    const cov = computeCoverage([shift({ id: "d1", role: "driver", assignees: [1] })]);
    expect(cov.byShift.d1.covered).toBe(1);
    expect(cov.byShift.d1.gap).toBe(0);
    expect(cov.byShift.d1.assigned).toBe(1);
    expect(cov.gapTotal).toBe(0);
    expect(cov.internalTotal).toBe(1);
  });

  it("an unassigned driver shift is an HONEST gap (scheduled crew are not credited here)", () => {
    const cov = computeCoverage([shift({ id: "d1", role: "driver" })]);
    expect(cov.byShift.d1.covered).toBe(0);
    expect(cov.byShift.d1.gap).toBe(1);
    expect(cov.byShift.d1.scheduledCredit).toBe(0);
    expect(cov.byShift.d1.scheduledNames).toEqual([]);
    expect(cov.byShift.d1.scheduledUserIds).toEqual([]);
    expect(cov.gapTotal).toBe(1);
  });

  it("caps covered at headcount and never reports a negative gap", () => {
    const cov = computeCoverage([shift({ id: "d1", role: "driver", headcount: 1, assignees: [1, 2] })]);
    expect(cov.byShift.d1.covered).toBe(1);
    expect(cov.byShift.d1.gap).toBe(0);
  });

  it("a multi-headcount prep shift with one explicit assignee leaves the rest a gap", () => {
    const cov = computeCoverage([shift({ id: "p1", role: "prep", headcount: 3, assignees: [2] })]);
    expect(cov.byShift.p1.covered).toBe(1);
    expect(cov.byShift.p1.gap).toBe(2);
  });

  it("field is counted from explicit assignees only (unchanged)", () => {
    const cov = computeCoverage([shift({ id: "f1", role: "field" })]);
    expect(cov.byShift.f1.gap).toBe(1);
    expect(cov.byShift.f1.scheduledCredit).toBe(0);
  });
});
