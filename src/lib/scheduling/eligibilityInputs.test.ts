import { describe, it, expect } from "vitest";
import { assignmentWindowsFromShifts } from "./eligibilityInputs";
import type { StaffShift } from "./types";

function shift(p: Partial<StaffShift> & { id: string }): StaffShift {
  return {
    date: "2026-10-05",
    role: "driver",
    headcount: 1,
    startTime: null,
    endTime: null,
    windowKnown: false,
    location: null,
    routeId: p.id,
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

describe("assignmentWindowsFromShifts", () => {
  it("emits one window per (worker × shift) with the shift's own window in Unix seconds", () => {
    const s = shift({ id: "r1", startTime: "2026-10-05T10:00:00Z", endTime: "2026-10-05T14:00:00Z", windowKnown: true, assignees: [1, 2] });
    const out = assignmentWindowsFromShifts([s]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ userId: 1, shiftId: "r1", start: Date.parse("2026-10-05T10:00:00Z") / 1000, end: Date.parse("2026-10-05T14:00:00Z") / 1000 });
    expect(out[1].userId).toBe(2);
  });

  it("yields null start/end for an unknown-window shift (never fabricates a time)", () => {
    const s = shift({ id: "r2", windowKnown: false, startTime: null, endTime: null, assignees: [7] });
    const out = assignmentWindowsFromShifts([s]);
    expect(out).toEqual([{ userId: 7, shiftId: "r2", start: null, end: null }]);
  });

  it("skips shifts with no assignees", () => {
    expect(assignmentWindowsFromShifts([shift({ id: "r3", assignees: [] })])).toEqual([]);
  });
});
