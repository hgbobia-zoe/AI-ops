import { describe, expect, it } from "vitest";
import { writeRoute, getActiveRouteForTruck } from "./repo";
import type { Route, RouteStatus } from "@/lib/types";

// DATABASE_PATH is ":memory:" (vitest.config.ts).
function seed(truckId: string, date: string, status: RouteStatus = "ready"): void {
  const routeId = `R-${date}-${truckId}`;
  const route: Route = {
    routeId,
    date,
    truckId,
    status,
    stops: [
      { stopId: `${routeId}-S1`, routeId, customerId: "C1", sequence: 1, state: "Waiting", custName: `${date} stop`, custPhone: "+15555550111", address: "1 Main St" },
    ],
  };
  writeRoute(route);
}

describe("getActiveRouteForTruck (tablet route = today, never a future day)", () => {
  it("returns TODAY's route even when a future route was written more recently", () => {
    const today = "2026-09-17";
    seed("ISU", "2026-09-17"); // today
    seed("ISU", "2026-09-28"); // future, written after → would win under 'latest updated'
    const r = getActiveRouteForTruck("ISU", today);
    expect(r?.date).toBe("2026-09-17");
    expect(r?.stops[0].custName).toBe("2026-09-17 stop");
  });

  it("never shows a future route when there is none today", () => {
    const today = "2026-09-17";
    seed("FUT", "2026-09-20");
    seed("FUT", "2026-09-28");
    expect(getActiveRouteForTruck("FUT", today)).toBeNull();
  });

  it("falls back to a still-unfinished past route (overnight / carryover)", () => {
    const today = "2026-09-17";
    seed("CARRY", "2026-09-15", "active"); // not done, before today
    seed("CARRY", "2026-09-25"); // future — must be ignored
    const r = getActiveRouteForTruck("CARRY", today);
    expect(r?.date).toBe("2026-09-15");
  });

  it("does NOT resurrect a finished past route", () => {
    const today = "2026-09-17";
    seed("DONE", "2026-09-15", "done");
    expect(getActiveRouteForTruck("DONE", today)).toBeNull();
  });
});
