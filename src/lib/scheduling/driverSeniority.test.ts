import { describe, expect, it } from "vitest";
import { resolveDriverSeniority, type SeniorityDriverCandidate, type SeniorityRouteMeta } from "./driverSeniority";

const T = 1_700_000_000; // an arbitrary same start time (Unix seconds)

function route(routeId: string, startUnix: number | null, difficulty: number, driverGap = 1): SeniorityRouteMeta {
  return { routeId, startUnix, driverGap, difficulty, specialty: difficulty > 0, reasons: difficulty > 0 ? ["tent"] : [] };
}
function driver(userId: number, name: string, seniorityDate: string | null, eligibleRouteIds: string[]): SeniorityDriverCandidate {
  return { userId, name, seniorityDate, eligibleRouteIds };
}

describe("resolveDriverSeniority", () => {
  it("puts the senior driver on the specialty route and the newer on the easy one (same start time)", () => {
    const routes = [route("R-spec", T, 3), route("R-easy", T, 0)];
    const drivers = [
      driver(1, "Senior", "2019-01-01", ["R-spec", "R-easy"]),
      driver(2, "Newer", "2024-06-01", ["R-spec", "R-easy"]),
    ];
    const plan = resolveDriverSeniority(drivers, routes);
    const byUser = new Map(plan.autoAssign.map((a) => [a.userId, a.routeId]));
    expect(byUser.get(1)).toBe("R-spec"); // senior → specialty
    expect(byUser.get(2)).toBe("R-easy"); // newer → easy
    expect(plan.resolvedUserIds.sort()).toEqual([1, 2]);
    // The senior's decision explains the specialty routing.
    expect(plan.autoAssign.find((a) => a.userId === 1)?.reasons.join(" ")).toMatch(/specialty route/);
  });

  it("treats an unknown seniority date as the NEWEST (known tenure outranks it)", () => {
    const routes = [route("R-spec", T, 2), route("R-easy", T, 0)];
    const drivers = [
      driver(1, "NoDate", null, ["R-spec", "R-easy"]),
      driver(2, "HasDate", "2023-01-01", ["R-spec", "R-easy"]),
    ];
    const plan = resolveDriverSeniority(drivers, routes);
    const byUser = new Map(plan.autoAssign.map((a) => [a.userId, a.routeId]));
    expect(byUser.get(2)).toBe("R-spec"); // known date = more senior → specialty
    expect(byUser.get(1)).toBe("R-easy"); // unknown = newest → easy
  });

  it("never places a driver on a route they are not eligible for", () => {
    const routes = [route("R-spec", T, 3), route("R-easy", T, 0)];
    const drivers = [
      driver(1, "Senior", "2019-01-01", ["R-easy"]), // senior can only do the easy route
      driver(2, "Newer", "2024-06-01", ["R-spec", "R-easy"]),
    ];
    const plan = resolveDriverSeniority(drivers, routes);
    const byUser = new Map(plan.autoAssign.map((a) => [a.userId, a.routeId]));
    expect(byUser.get(1)).toBe("R-easy"); // eligibility wins over seniority
    expect(byUser.get(2)).toBe("R-spec");
  });

  it("does nothing for a single route (no same-time contest)", () => {
    const routes = [route("R1", T, 3)];
    const drivers = [driver(1, "A", "2019-01-01", ["R1"]), driver(2, "B", "2024-01-01", ["R1"])];
    expect(resolveDriverSeniority(drivers, routes).autoAssign).toEqual([]);
  });

  it("does nothing when only one driver is eligible", () => {
    const routes = [route("R-spec", T, 3), route("R-easy", T, 0)];
    const drivers = [driver(1, "Solo", "2019-01-01", ["R-spec", "R-easy"])];
    expect(resolveDriverSeniority(drivers, routes).resolvedUserIds).toEqual([]);
  });

  it("does not cluster routes that start at different times", () => {
    const routes = [route("R-spec", T, 3), route("R-easy", T + 3600, 0)];
    const drivers = [
      driver(1, "Senior", "2019-01-01", ["R-spec", "R-easy"]),
      driver(2, "Newer", "2024-06-01", ["R-spec", "R-easy"]),
    ];
    expect(resolveDriverSeniority(drivers, routes).autoAssign).toEqual([]);
  });

  it("ignores routes with an unknown start time or no driver gap", () => {
    const routes = [route("R-noStart", null, 3), route("R-filled", T, 0, 0)];
    const drivers = [
      driver(1, "Senior", "2019-01-01", ["R-noStart", "R-filled"]),
      driver(2, "Newer", "2024-06-01", ["R-noStart", "R-filled"]),
    ];
    expect(resolveDriverSeniority(drivers, routes).autoAssign).toEqual([]);
  });
});
