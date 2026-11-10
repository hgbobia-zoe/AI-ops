import { describe, expect, it } from "vitest";
import { routeOptimize, buildTrips, neededPairs, type RouteAnchor, type LatLng, type DistanceFn } from "./routeOptimize";

// Points are identified by a unique `lat` (lng always 0); distances come from an explicit symmetric matrix
// keyed by the sorted lat pair. This keeps the engine's math fully deterministic and easy to reason about.
const WH: LatLng = { lat: 0, lng: 0 };
const V: LatLng = { lat: 1, lng: 0 };
const pt = (lat: number): LatLng => ({ lat, lng: 0 });

function matrixDist(miles: Record<string, number>, minutes?: Record<string, number>): DistanceFn {
  const key = (a: LatLng, b: LatLng) => [a.lat, b.lat].sort((x, y) => x - y).join("-");
  return (a, b) => {
    if (a.lat === b.lat) return { miles: 0, minutes: 0 };
    const k = key(a, b);
    const mi = miles[k];
    if (mi == null) throw new Error(`no distance for ${k}`);
    return { miles: mi, minutes: minutes?.[k] ?? mi };
  };
}

const anchor = (lat: number, over: Partial<RouteAnchor> = {}): RouteAnchor => ({
  id: `A${lat}`,
  label: `job ${lat}`,
  coords: pt(lat),
  windowKnown: true,
  source: "route",
  truckId: "T1",
  ...over,
});

describe("routeOptimize mode selection", () => {
  it("STANDARD when there are no anchors — bills the warehouse distance", () => {
    const r = routeOptimize({
      venue: V,
      warehouse: WH,
      warehouseMiles: 10,
      anchors: [],
      dist: () => ({ miles: 0, minutes: 0 }),
      routeRadiusMiles: 15,
      timingToleranceMinutes: 45,
      mode: "round_trip",
    });
    expect(r.mode).toBe("STANDARD");
    expect(r.billableMiles).toBe(10);
    expect(r.savingsMiles).toBeNull();
  });

  it("ROUTE_OPTIMIZED bills the incremental distance the stop adds (inc = prev→new + new→next − prev→next)", () => {
    // WH-V=10, WH-A=8, V-A=5 ⇒ inc = 10 + 5 − 8 = 7, which beats the 10-mi dedicated run.
    const r = routeOptimize({
      venue: V,
      warehouse: WH,
      warehouseMiles: 10,
      anchors: [anchor(2)],
      dist: matrixDist({ "0-1": 10, "0-2": 8, "1-2": 5 }),
      routeRadiusMiles: 15,
      timingToleranceMinutes: 45,
      mode: "round_trip",
    });
    expect(r.mode).toBe("ROUTE_OPTIMIZED");
    expect(r.billableMiles).toBe(7);
    expect(r.incrementalMiles).toBe(7);
    expect(r.savingsMiles).toBe(3);
    expect(r.anchor?.id).toBe("A2");
    expect(r.anchor?.timingVerified).toBe(true);
  });

  it("picks the MINIMUM feasible incremental across trucks", () => {
    // A2 (T1): inc = 10 + 5 − 8 = 7.  C3 (T2): inc = 10 + 4 − 11 = 3  ⇒ best is 3.
    const r = routeOptimize({
      venue: V,
      warehouse: WH,
      warehouseMiles: 10,
      anchors: [anchor(2, { truckId: "T1" }), anchor(3, { id: "C3", truckId: "T2" })],
      dist: matrixDist({ "0-1": 10, "0-2": 8, "1-2": 5, "0-3": 11, "1-3": 4 }),
      routeRadiusMiles: 15,
      timingToleranceMinutes: 45,
      mode: "round_trip",
    });
    expect(r.mode).toBe("ROUTE_OPTIMIZED");
    expect(r.billableMiles).toBe(3);
    expect(r.savingsMiles).toBe(7);
    expect(r.anchor?.id).toBe("C3");
  });

  it("DEDICATED when the only anchor is beyond the route radius", () => {
    const r = routeOptimize({
      venue: V,
      warehouse: WH,
      warehouseMiles: 10,
      anchors: [anchor(2)],
      dist: matrixDist({ "0-1": 10, "0-2": 8, "1-2": 20 }), // V→A is 20 mi, radius is 15
      routeRadiusMiles: 15,
      timingToleranceMinutes: 45,
      mode: "round_trip",
    });
    expect(r.mode).toBe("DEDICATED");
    expect(r.billableMiles).toBe(10);
    expect(r.incrementalMiles).toBeNull();
    expect(r.reasons.join(" ")).toMatch(/within 15 mi/);
  });

  it("DEDICATED when a KNOWN window would be pushed past the timing tolerance", () => {
    // Distances would optimize (inc 7 < 10), but the detour adds 110 min > 45-min tolerance.
    const r = routeOptimize({
      venue: V,
      warehouse: WH,
      warehouseMiles: 10,
      anchors: [anchor(2, { windowKnown: true })],
      dist: matrixDist({ "0-1": 10, "0-2": 8, "1-2": 5 }, { "0-1": 60, "0-2": 10, "1-2": 60 }),
      routeRadiusMiles: 15,
      timingToleranceMinutes: 45,
      mode: "round_trip",
    });
    expect(r.mode).toBe("DEDICATED");
    expect(r.billableMiles).toBe(10);
    expect(r.reasons.join(" ")).toMatch(/tolerance/);
  });

  it("allows an unrouted booking (unknown window) as a candidate but flags timing unverified", () => {
    // Same high-minute matrix, but the anchor's window is UNKNOWN ⇒ timing is not enforced.
    const r = routeOptimize({
      venue: V,
      warehouse: WH,
      warehouseMiles: 10,
      anchors: [anchor(2, { windowKnown: false, source: "booking", truckId: null })],
      dist: matrixDist({ "0-1": 10, "0-2": 8, "1-2": 5 }, { "0-1": 60, "0-2": 10, "1-2": 60 }),
      routeRadiusMiles: 15,
      timingToleranceMinutes: 45,
      mode: "round_trip",
    });
    expect(r.mode).toBe("ROUTE_OPTIMIZED");
    expect(r.billableMiles).toBe(7);
    expect(r.anchor?.timingVerified).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/ASSUMED/);
  });
});

describe("buildTrips", () => {
  it("groups anchors by truck and makes each unrouted booking its own singleton trip", () => {
    const trips = buildTrips([
      anchor(2, { id: "s1", truckId: "T1", order: 2 }),
      anchor(3, { id: "s2", truckId: "T1", order: 1 }),
      anchor(4, { id: "b1", truckId: null, source: "booking", windowKnown: false }),
    ]);
    const t1 = trips.find((t) => t.truckId === "T1");
    expect(t1?.stops.map((s) => s.id)).toEqual(["s2", "s1"]); // ordered by `order`
    expect(trips.filter((t) => t.truckId === null)).toHaveLength(1);
  });
});

describe("buildTrips by truck and route", () => {
  it("one truck's two routes on the same day are two trips", () => {
    const trips = buildTrips([
      anchor(2, { id: "a1", truckId: "T1", routeId: "R-A", order: 1 }),
      anchor(3, { id: "b1", truckId: "T1", routeId: "R-B", order: 1 }),
      anchor(4, { id: "a2", truckId: "T1", routeId: "R-A", order: 2 }),
    ]);
    expect(trips).toHaveLength(2);
    expect(trips.find((t) => t.routeId === "R-A")?.stops.map((s) => s.id)).toEqual(["a1", "a2"]);
    expect(trips.every((t) => t.truckId === "T1")).toBe(true);
  });
});

describe("neededPairs + air prefilter", () => {
  it("skips gaps whose neighbours are all beyond the radius by air, and the engine never asks for them", () => {
    // Air miles = |lat difference| here; A2 (lat 2) is near the venue (lat 1), A50 is far.
    const air = (a: LatLng, b: LatLng) => Math.abs(a.lat - b.lat);
    const anchors = [anchor(2, { id: "near", order: 1 }), anchor(50, { id: "far", order: 2 })];
    const pairs = neededPairs({ venue: V, warehouse: WH, anchors, routeRadiusMiles: 15, air });
    // Gaps: WH-near (kept), near-far (kept: near is in reach), far-WH (skipped).
    expect(pairs).toHaveLength(6);
    const asked = new Set<string>();
    const k = (a: LatLng, b: LatLng) => [a.lat, b.lat].sort((x, y) => x - y).join("-");
    const dist: DistanceFn = (a, b) => {
      asked.add(k(a, b));
      return { miles: Math.abs(a.lat - b.lat), minutes: Math.abs(a.lat - b.lat) };
    };
    routeOptimize({ venue: V, warehouse: WH, warehouseMiles: 10, anchors, dist, routeRadiusMiles: 15, timingToleranceMinutes: 45, mode: "round_trip", air });
    const allowed = new Set(pairs.map(([a, b]) => k(a, b)));
    for (const p of asked) expect(allowed.has(p)).toBe(true);
    expect(asked.has("1-50")).toBe(true); // the near-far gap is checked
    expect(asked.has("0-50")).toBe(false); // the far-WH gap is not
  });
});
