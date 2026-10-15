// Unit coverage for the shared cross-blade staffing selector. It must agree with the pre-check engine
// (same required/assigned/gap math) and never credit a Connecteam schedule as coverage.

import { describe, it, expect } from "vitest";
import { writeRoute, setRouteDriver } from "@/lib/db/repo";
import { createShift } from "./store";
import { getDayStaffingSummary, routeStaffingLabel } from "./routeStaffing";
import { computeRouteGap } from "./preCheck";
import { mockRoute } from "@/lib/mockData";

const DATE = "2026-10-20";

describe("routeStaffing shared selector", () => {
  it("flags a populated route with no driver as an unmet gap (nobody assigned)", () => {
    writeRoute(mockRoute("NPR-1", DATE));
    const summary = getDayStaffingSummary(DATE);
    const state = summary.routes.find((r) => r.truckId === "NPR-1");
    expect(state).toBeDefined();
    expect(state!.requiresCrew).toBe(true);
    expect(state!.requiredByRole.driver).toBe(1);
    expect(state!.hasDriver).toBe(false);
    expect(state!.status).toBe("gap");
    expect(state!.nobody).toBe(true);
    expect(summary.routesRequiringCrew).toBe(1);
    expect(summary.routesWithGap).toBe(1);
    expect(summary.routesCovered).toBe(0);
  });

  it("clears the driver seat once a driver is recorded on the route (app assignment only)", () => {
    const route = mockRoute("NPR-2", DATE);
    writeRoute(route);
    setRouteDriver(route.routeId, "99", "Pat Driver");
    const state = getDayStaffingSummary(DATE).routes.find((r) => r.truckId === "NPR-2")!;
    expect(state.hasDriver).toBe(true);
    expect(state.driverName).toBe("Pat Driver");
    expect(state.assignedByRole.driver).toBeGreaterThanOrEqual(1);
    expect(state.gapByRole.driver).toBe(0);
  });

  it("counts a field app-shift assignee toward coverage and matches computeRouteGap exactly", () => {
    const route = mockRoute("E450", DATE);
    writeRoute(route);
    setRouteDriver(route.routeId, "7", "Sam");
    // A field helper assigned in the app (NOT merely scheduled in Connecteam).
    createShift({ date: DATE, role: "field", headcount: 1, routeId: route.routeId, truckId: "E450", assignees: [42] });
    const state = getDayStaffingSummary(DATE).routes.find((r) => r.truckId === "E450")!;
    const pure = computeRouteGap({ requiredByRole: state.requiredByRole, assignedByRole: state.assignedByRole });
    expect(state.totalGap).toBe(pure.totalGap);
    expect(state.status).toBe(pure.status);
    expect(state.assignedByRole.field).toBe(1);
  });

  it("confirmation state is UNKNOWN (0, not fabricated) when the comms loop is not wired", () => {
    writeRoute(mockRoute("NPR-1", DATE));
    const summary = getDayStaffingSummary(DATE);
    // SHIFT_COMMS_ENABLED is off in the test env → confirmations are not knowable.
    expect(summary.confirmationsKnown).toBe(false);
    expect(summary.pendingConfirmations).toBe(0);
  });

  it("labels gap verdicts deterministically", () => {
    expect(routeStaffingLabel(computeRouteGap({ requiredByRole: { driver: 1, field: 0 }, assignedByRole: { driver: 1, field: 0 } }), true)).toBe("Fully staffed");
    expect(routeStaffingLabel(computeRouteGap({ requiredByRole: { driver: 1, field: 2 }, assignedByRole: { driver: 1, field: 0 } }), true)).toBe("Understaffed · 2 open");
    expect(routeStaffingLabel(computeRouteGap({ requiredByRole: { driver: 1, field: 0 }, assignedByRole: { driver: 0, field: 0 } }), true)).toBe("No crew assigned");
    expect(routeStaffingLabel(computeRouteGap({ requiredByRole: { driver: 0, field: 0 }, assignedByRole: { driver: 0, field: 0 } }), false)).toBe("No crew required");
  });
});
