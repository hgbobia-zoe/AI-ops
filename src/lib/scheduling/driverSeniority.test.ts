import { describe, expect, it } from "vitest";
import { resolveDriverSeniority, type SeniorityDriverCandidate, type SeniorityRouteMeta } from "./driverSeniority";

const T = 1_700_000_000; // an arbitrary start time (Unix seconds)

function route(routeId: string, startUnix: number | null, difficulty: number, driverGap = 1): SeniorityRouteMeta {
  return { routeId, startUnix, driverGap, difficulty, specialty: difficulty > 0, reasons: difficulty > 0 ? ["tent"] : [] };
}
function driver(userId: number, name: string, seniorityDate: string | null, eligibleRouteIds: string[]): SeniorityDriverCandidate {
  return { userId, name, seniorityDate, eligibleRouteIds };
}

describe("resolveDriverSeniority (generalized)", () => {
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
    expect(plan.autoAssign.find((a) => a.userId === 1)?.reasons.join(" ")).toMatch(/specialty route/);
  });

  it("treats an unknown seniority date as the NEWEST (known tenure outranks it)", () => {
    const routes = [route("R-spec", T, 2), route("R-easy", T, 0)];
    const drivers = [
      driver(1, "NoDate", null, ["R-spec", "R-easy"]),
      driver(2, "HasDate", "2023-01-01", ["R-spec", "R-easy"]),
    ];
    const byUser = new Map(resolveDriverSeniority(drivers, routes).autoAssign.map((a) => [a.userId, a.routeId]));
    expect(byUser.get(2)).toBe("R-spec"); // known date = more senior → specialty
    expect(byUser.get(1)).toBe("R-easy"); // unknown = newest → easy
  });

  it("FILLS routes that start at DIFFERENT times (the gap the same-start-only rule used to leave open)", () => {
    const routes = [route("R-spec", T, 3), route("R-easy", T + 3600, 0)];
    const drivers = [
      driver(1, "Senior", "2019-01-01", ["R-spec", "R-easy"]),
      driver(2, "Newer", "2024-06-01", ["R-spec", "R-easy"]),
    ];
    const plan = resolveDriverSeniority(drivers, routes);
    const byUser = new Map(plan.autoAssign.map((a) => [a.userId, a.routeId]));
    expect(byUser.get(1)).toBe("R-spec"); // senior → the harder route, even at a different start time
    expect(byUser.get(2)).toBe("R-easy");
    expect(plan.resolvedUserIds.sort()).toEqual([1, 2]);
  });

  it("eligibility ALWAYS wins over seniority (never placed on a route they can't do)", () => {
    const routes = [route("R-spec", T, 3), route("R-easy", T, 0)];
    const drivers = [
      driver(1, "Senior", "2019-01-01", ["R-easy"]), // senior can only do the easy route
      driver(2, "Newer", "2024-06-01", ["R-spec", "R-easy"]),
    ];
    const byUser = new Map(resolveDriverSeniority(drivers, routes).autoAssign.map((a) => [a.userId, a.routeId]));
    expect(byUser.get(1)).toBe("R-easy");
    expect(byUser.get(2)).toBe("R-spec");
  });

  it("maximizes COVERAGE via forced moves before the seniority tiebreak", () => {
    // A (senior) could do either; B (newer) can only do R1. Naive 'senior grabs the hard route' would strand
    // R2 (B can't take it). Forced-move propagation places B on R1 first, then A on R2 — both covered.
    const routes = [route("R1", T, 3), route("R2", T + 3600, 0)];
    const drivers = [
      driver(1, "A-Senior", "2019-01-01", ["R1", "R2"]),
      driver(2, "B-Newer", "2024-06-01", ["R1"]),
    ];
    const byUser = new Map(resolveDriverSeniority(drivers, routes).autoAssign.map((a) => [a.userId, a.routeId]));
    expect(byUser.get(2)).toBe("R1"); // forced: B's only option
    expect(byUser.get(1)).toBe("R2"); // A takes what's left
    expect(byUser.size).toBe(2); // full coverage
  });

  it("places a solo driver on the hardest route they fit (one driver, two gapped routes)", () => {
    const routes = [route("R-spec", T, 3), route("R-easy", T, 0)];
    const plan = resolveDriverSeniority([driver(1, "Solo", "2019-01-01", ["R-spec", "R-easy"])], routes);
    expect(plan.autoAssign.map((a) => a.routeId)).toEqual(["R-spec"]);
    expect(plan.resolvedUserIds).toEqual([1]);
  });

  it("respects a route's open driver seats (never over-fills a single-seat route)", () => {
    const routes = [route("R1", T, 0, 1)]; // one seat
    const drivers = [
      driver(1, "A", "2019-01-01", ["R1"]),
      driver(2, "B", "2020-01-01", ["R1"]),
      driver(3, "C", "2021-01-01", ["R1"]),
    ];
    const plan = resolveDriverSeniority(drivers, routes);
    expect(plan.autoAssign).toHaveLength(1);
    expect(plan.autoAssign[0]).toMatchObject({ userId: 1, routeId: "R1" }); // most senior takes the lone seat
  });

  it("fills BOTH seats of a two-seat route, most senior first", () => {
    const routes = [route("R1", T, 0, 2)];
    const drivers = [driver(1, "A", "2019-01-01", ["R1"]), driver(2, "B", "2020-01-01", ["R1"]), driver(3, "C", "2021-01-01", ["R1"])];
    const plan = resolveDriverSeniority(drivers, routes);
    expect(plan.autoAssign.map((a) => a.userId).sort()).toEqual([1, 2]); // two most senior; C left over
  });

  it("assigns a route with an UNKNOWN start time, and ignores routes with no driver gap", () => {
    const routes = [route("R-noStart", null, 3, 1), route("R-filled", T, 0, 0)];
    const drivers = [
      driver(1, "Senior", "2019-01-01", ["R-noStart", "R-filled"]),
      driver(2, "Newer", "2024-06-01", ["R-noStart", "R-filled"]),
    ];
    const plan = resolveDriverSeniority(drivers, routes);
    expect(plan.autoAssign).toHaveLength(1); // only R-noStart has a seat; unknown start no longer blocks it
    expect(plan.autoAssign[0]).toMatchObject({ userId: 1, routeId: "R-noStart" });
  });

  it("returns nothing when there are no gapped routes", () => {
    const routes = [route("R1", T, 3, 0)];
    const plan = resolveDriverSeniority([driver(1, "A", "2019-01-01", ["R1"])], routes);
    expect(plan.autoAssign).toEqual([]);
    expect(plan.resolvedUserIds).toEqual([]);
  });
});
