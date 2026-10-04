import { describe, it, expect } from "vitest";
import { scanShiftExceptions } from "./exceptions";
import type { DayCoverage, ShiftCoverage } from "./coverage";
import type { StaffShift, ShiftRole } from "./types";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const FAR = "2026-10-20T14:00:00Z"; // > 1 day out
const SOON = "2026-10-01T12:00:00Z"; // same day (< 1 day out)

function shift(p: Partial<StaffShift> & { id: string; role: ShiftRole }): StaffShift {
  return {
    date: "2026-10-20",
    headcount: 1,
    startTime: null,
    endTime: null,
    windowKnown: true,
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

function cov(byShift: Record<string, number>): DayCoverage {
  const full: Record<string, ShiftCoverage> = {};
  let gapTotal = 0;
  for (const [id, gap] of Object.entries(byShift)) {
    full[id] = { headcount: 1, assigned: 0, scheduledCredit: 0, scheduledNames: [], scheduledUserIds: [], covered: 0, gap };
    gapTotal += gap;
  }
  return { byShift: full, internalTotal: 0, gapTotal };
}

describe("scanShiftExceptions", () => {
  it("flags an understaffed shift YELLOW far out, RED within T-1d", () => {
    const far = scanShiftExceptions({ shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: "T1", startTime: FAR, endTime: FAR })], coverage: cov({ a: 1 }), now: NOW });
    expect(far.find((e) => e.code === "understaffed")!.severity).toBe("YELLOW");

    const near = scanShiftExceptions({ shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: "T1", startTime: SOON, endTime: SOON })], coverage: cov({ a: 1 }), now: NOW });
    expect(near.find((e) => e.code === "understaffed")!.severity).toBe("RED");
  });

  it("does NOT flag understaffed when staffing is unverified (UNKNOWN, not fabricated)", () => {
    const out = scanShiftExceptions({ shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: "T1", startTime: FAR, endTime: FAR })], coverage: cov({ a: 1 }), now: NOW, staffingVerified: false });
    expect(out.find((e) => e.code === "understaffed")).toBeUndefined();
  });

  it("flags a route shift with no truck RED", () => {
    const out = scanShiftExceptions({ shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: null, startTime: FAR, endTime: FAR })], coverage: cov({ a: 0 }), now: NOW });
    const e = out.find((x) => x.code === "no_truck")!;
    expect(e.severity).toBe("RED");
  });

  it("flags an unknown window YELLOW", () => {
    const out = scanShiftExceptions({ shifts: [shift({ id: "a", role: "prep", windowKnown: false })], coverage: cov({ a: 0 }), now: NOW });
    expect(out.find((e) => e.code === "no_window")!.severity).toBe("YELLOW");
  });

  it("flags staffed-but-not-published and a missing supervisor", () => {
    const out = scanShiftExceptions({
      shifts: [shift({ id: "a", role: "field", routeId: "a", truckId: "T1", headcount: 2, assignees: [1, 2], startTime: FAR, endTime: FAR })],
      coverage: cov({ a: 0 }),
      now: NOW,
    });
    expect(out.find((e) => e.code === "not_published")).toBeTruthy();
    expect(out.find((e) => e.code === "supervisor_missing")).toBeTruthy();
  });

  it("sorts RED before YELLOW", () => {
    const out = scanShiftExceptions({
      shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: null, windowKnown: false })],
      coverage: cov({ a: 0 }),
      now: NOW,
    });
    expect(out[0].severity).toBe("RED"); // no_truck
    expect(out.map((e) => e.severity)).toEqual([...out.map((e) => e.severity)].sort());
  });

  it("skips cancelled shifts", () => {
    const out = scanShiftExceptions({ shifts: [shift({ id: "a", role: "driver", routeId: "a", truckId: null, status: "cancelled" })], coverage: cov({ a: 1 }), now: NOW });
    expect(out).toHaveLength(0);
  });
});
