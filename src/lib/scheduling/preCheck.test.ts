import { describe, it, expect } from "vitest";
import { computeRouteGap, requiredCrewForRoute, assignedCrewForRoute } from "./preCheck";
import type { Route, Stop } from "@/lib/types";
import type { StaffShift } from "./types";

function stop(p: Partial<Stop> & { sequence: number }): Stop {
  return {
    stopId: `s${p.sequence}`,
    routeId: "r1",
    customerId: "c1",
    state: "pending" as Stop["state"],
    custName: `Cust ${p.sequence}`,
    custPhone: "",
    address: "",
    ...p,
  } as Stop;
}

function route(p: Partial<Route> & { stops: Stop[] }): Route {
  return { routeId: "r1", date: "2026-10-10", truckId: "E450", status: "active", stops: p.stops, ...p };
}

function shift(p: Partial<StaffShift> & { id: string; role: StaffShift["role"] }): StaffShift {
  return {
    date: "2026-10-10", headcount: 1, startTime: null, endTime: null, windowKnown: false, location: null,
    routeId: "r1", truckId: "E450", eventLabel: null, reasons: [], notes: null, source: "derived",
    status: "draft", assignees: [], instaworkHeadcount: 0, payRate: null, connecteamShiftId: null,
    connecteamSchedulerId: null, connecteamPublishedAt: null, instaworkGigId: null, instaworkPostedAt: null,
    lifecycleState: null, supervisorUserId: null, reportLocation: null, reportTime: null, equipment: [],
    instructions: null, createdAt: "", updatedAt: "", ...p,
  };
}

// Status is PURELY explicit app assignments vs required crew — there is no ack / "mark done" override, so a
// gap can ONLY ever be "gap" or "ok".
describe("computeRouteGap (pure gap math + status)", () => {
  it("nobody assigned → gap, nobody flag, 'Nobody assigned'", () => {
    const g = computeRouteGap({ requiredByRole: { driver: 1, field: 1 }, assignedByRole: { driver: 0, field: 0 } });
    expect(g.status).toBe("gap");
    expect(g.nobody).toBe(true);
    expect(g.totalGap).toBe(2);
    expect(g.reason).toBe("Nobody assigned");
  });

  it("driver missing (helpers present) → 'no driver'", () => {
    const g = computeRouteGap({ requiredByRole: { driver: 1, field: 1 }, assignedByRole: { driver: 0, field: 1 } });
    expect(g.status).toBe("gap");
    expect(g.nobody).toBe(false);
    expect(g.gapByRole).toEqual({ driver: 1, field: 0 });
    expect(g.reason).toBe("no driver");
  });

  it("short helpers → 'needs N more helpers' (pluralized)", () => {
    const g2 = computeRouteGap({ requiredByRole: { driver: 1, field: 2 }, assignedByRole: { driver: 1, field: 0 } });
    expect(g2.gapByRole).toEqual({ driver: 0, field: 2 });
    expect(g2.reason).toBe("needs 2 more helpers");
    const g1 = computeRouteGap({ requiredByRole: { driver: 1, field: 2 }, assignedByRole: { driver: 1, field: 1 } });
    expect(g1.reason).toBe("needs 1 more helper");
  });

  it("fully assigned → ok, no gap", () => {
    const g = computeRouteGap({ requiredByRole: { driver: 1, field: 1 }, assignedByRole: { driver: 1, field: 1 } });
    expect(g.status).toBe("ok");
    expect(g.totalGap).toBe(0);
    expect(g.reason).toBe("Fully staffed");
  });

  it("over-assigned is capped (never a negative gap) and reads ok", () => {
    const g = computeRouteGap({ requiredByRole: { driver: 1, field: 1 }, assignedByRole: { driver: 2, field: 3 } });
    expect(g.gapByRole).toEqual({ driver: 0, field: 0 });
    expect(g.status).toBe("ok");
  });

  it("the ONLY way out of a gap is assigning crew (partial assignment still a gap)", () => {
    const g = computeRouteGap({ requiredByRole: { driver: 1, field: 2 }, assignedByRole: { driver: 1, field: 1 } });
    expect(g.status).toBe("gap");
    expect(g.totalGap).toBe(1);
  });
});

describe("requiredCrewForRoute (crew rules)", () => {
  it("plain route needs just a driver", () => {
    const g = requiredCrewForRoute(route({ stops: [stop({ sequence: 1, items: [{ name: "Chairs" }] })] }));
    expect(g).toEqual({ driver: 1, field: 0 });
  });
  it("a tent adds one helper", () => {
    const g = requiredCrewForRoute(route({ stops: [stop({ sequence: 1, items: [{ name: "20x20 Tent" }] })] }));
    expect(g).toEqual({ driver: 1, field: 1 });
  });
  it("a big tent (40x60) needs two helpers", () => {
    const g = requiredCrewForRoute(route({ stops: [stop({ sequence: 1, items: [{ name: "40x60 Tent" }] })] }));
    expect(g).toEqual({ driver: 1, field: 2 });
  });
});

describe("assignedCrewForRoute (explicit app assignments only)", () => {
  it("Dispatch-assigned driver covers the driver seat even with no driver shift", () => {
    const r = route({ stops: [stop({ sequence: 1 })], driverId: "7", driverName: "Pat" });
    expect(assignedCrewForRoute(r, [])).toEqual({ driver: 1, field: 0 });
  });
  it("counts driver + field app-shift assignees; ignores prep", () => {
    const r = route({ stops: [stop({ sequence: 1 })] });
    const shifts = [
      shift({ id: "d", role: "driver", assignees: [1] }),
      shift({ id: "f", role: "field", assignees: [2, 3] }),
      shift({ id: "p", role: "prep", assignees: [9] }),
    ];
    expect(assignedCrewForRoute(r, shifts)).toEqual({ driver: 1, field: 2 });
  });
  it("a Connecteam-only (old-way) route has ZERO app assignment → nobody", () => {
    // No driverId, no app shifts with assignees — the whole point of the pre-check.
    const r = route({ stops: [stop({ sequence: 1 })] });
    const assigned = assignedCrewForRoute(r, []);
    expect(assigned).toEqual({ driver: 0, field: 0 });
    const g = computeRouteGap({ requiredByRole: requiredCrewForRoute(r), assignedByRole: assigned });
    expect(g.status).toBe("gap");
    expect(g.nobody).toBe(true);
  });
});
