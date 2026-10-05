// Route-aware delivery pricing — DETERMINISTIC. Given the new venue, the warehouse, and the day's signed
// delivery jobs (anchors), classify the quote into one of three modes and return the BILLABLE distance:
//
//   • STANDARD        — no other signed jobs with a delivery component that day → price on the one-way
//                        warehouse distance (a standalone trip).
//   • ROUTE OPTIMIZED — a feasible insertion into an existing same-day route/anchor exists → price on the
//                        INCREMENTAL distance the new stop ADDS to that trip:
//                            incremental = d(prev→new) + d(new→next) − d(prev→next)
//                        evaluated at every gap of each truck's sequence (warehouse at both ends). Pick the
//                        MINIMUM feasible incremental; bill on it when it beats a dedicated trip.
//   • DEDICATED       — other same-day jobs exist but NONE can feasibly share a route → price on the
//                        warehouse distance, labelled so the rep sees the system checked.
//
// This module is PURE: no DB, no network, no clock. Driving distances are supplied as a synchronous
// `dist(a,b)` function (the server backs it with a bounded, cached OSRM lookup; tests pass a matrix), so
// the SAME inputs always yield the SAME mode + numbers. RULES CALCULATE — no LLM anywhere in here. The
// returned `reasons[]` let the UI (or an AI) EXPLAIN the already-computed numbers; they never change them.

import type { LegMode } from "./delivery";
import type { LatLng } from "@/lib/eta/geo";

export type { LatLng };

export type PricingMode = "STANDARD" | "ROUTE_OPTIMIZED" | "DEDICATED";

/** A same-day signed job the new quote might share a trip with. */
export interface RouteAnchor {
  id: string;
  /** Rep-facing location label (event name / city / street). */
  label: string;
  coords: LatLng;
  /** The truck already serving this job, when it's on a route; null/undefined for an unrouted booking. */
  truckId?: string | null;
  kind?: "delivery" | "pickup";
  /** Sequence within its truck's route, used to order the trip. Undefined sorts last. */
  order?: number;
  /** True when a scheduled time window is known (route stop); false for an unrouted booking (window unknown). */
  windowKnown: boolean;
  /** "route" = precise street address + window + truck; "booking" = city-level geocode, window unknown. */
  source: "route" | "booking";
}

export interface DistanceResult {
  miles: number;
  minutes: number;
}
export type DistanceFn = (a: LatLng, b: LatLng) => DistanceResult;

export interface RouteOptimizeInput {
  venue: LatLng;
  warehouse: LatLng;
  /** Precomputed one-way warehouse→venue distance (miles) — the STANDARD / DEDICATED billable distance. */
  warehouseMiles: number;
  anchors: RouteAnchor[];
  dist: DistanceFn;
  routeRadiusMiles: number;
  timingToleranceMinutes: number;
  mode: LegMode;
}

export interface RouteAnchorRef {
  id: string;
  label: string;
  truckId: string | null;
  source: "route" | "booking";
  /** False when the shared job's window is unknown (unrouted booking) — the timing of the share is assumed. */
  timingVerified: boolean;
}

export interface RouteOptimizeResult {
  mode: PricingMode;
  warehouseMiles: number;
  billableMiles: number;
  incrementalMiles: number | null;
  savingsMiles: number | null;
  anchor: RouteAnchorRef | null;
  anchorsConsidered: number;
  /** Deterministic, human-readable explanation of how the mode + numbers were derived. */
  reasons: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface Trip {
  truckId: string | null;
  stops: RouteAnchor[];
}

/**
 * Group anchors into the trucks' planned trips: anchors sharing a truckId form one sequence (ordered by
 * `order`, then id); an unrouted anchor (no truckId) is its own one-stop trip. Trip order is sorted for
 * determinism. Exported so the server can collect exactly the point-pairs the engine will query.
 */
export function buildTrips(anchors: RouteAnchor[]): Trip[] {
  const byTruck = new Map<string, RouteAnchor[]>();
  const singletons: RouteAnchor[] = [];
  for (const a of anchors) {
    if (a.truckId) {
      const arr = byTruck.get(a.truckId) ?? [];
      arr.push(a);
      byTruck.set(a.truckId, arr);
    } else {
      singletons.push(a);
    }
  }
  const trips: Trip[] = [];
  for (const [truckId, stops] of byTruck) {
    stops.sort((x, y) => (x.order ?? Number.MAX_SAFE_INTEGER) - (y.order ?? Number.MAX_SAFE_INTEGER) || x.id.localeCompare(y.id));
    trips.push({ truckId, stops });
  }
  for (const s of singletons) trips.push({ truckId: null, stops: [s] });
  trips.sort((a, b) => String(a.truckId ?? "~").localeCompare(String(b.truckId ?? "~")));
  return trips;
}

type Node = RouteAnchor | "WH";
const isAnchor = (n: Node): n is RouteAnchor => n !== "WH";

interface Candidate {
  inc: number;
  incMin: number;
  anchor: RouteAnchor;
  truckId: string | null;
  timingVerified: boolean;
}

/** Classify the quote and compute its billable distance. Deterministic given its inputs. */
export function routeOptimize(input: RouteOptimizeInput): RouteOptimizeResult {
  const { venue, warehouse, warehouseMiles, anchors, dist, routeRadiusMiles, timingToleranceMinutes } = input;
  const reasons: string[] = [];
  const whMiles = round2(Math.max(0, warehouseMiles || 0));

  if (anchors.length === 0) {
    reasons.push("No other signed jobs with a delivery component on this date — priced as a standalone trip from the warehouse.");
    return { mode: "STANDARD", warehouseMiles: whMiles, billableMiles: whMiles, incrementalMiles: null, savingsMiles: null, anchor: null, anchorsConsidered: 0, reasons };
  }

  const trips = buildTrips(anchors);
  let best: Candidate | null = null;
  let anyWithinRadius = false;
  let anyWindowBlocked = false; // a share was blocked purely on timing (known window, over tolerance)

  for (const trip of trips) {
    const pad: Node[] = ["WH", ...trip.stops, "WH"];
    for (let i = 0; i < pad.length - 1; i++) {
      const prev = pad[i];
      const next = pad[i + 1];
      const prevPt = isAnchor(prev) ? prev.coords : warehouse;
      const nextPt = isAnchor(next) ? next.coords : warehouse;

      const dPrevNew = dist(prevPt, venue);
      const dNewNext = dist(venue, nextPt);
      const dPrevNext = dist(prevPt, nextPt);
      const inc = round2(dPrevNew.miles + dNewNext.miles - dPrevNext.miles);
      const incMin = dPrevNew.minutes + dNewNext.minutes - dPrevNext.minutes;

      const neighbors = [prev, next].filter(isAnchor);
      if (neighbors.length === 0) continue; // a gap bounded only by the warehouse can't anchor a share
      // Eligibility: the new stop must be within the radius of a real adjacent anchor (driving distance).
      let nearest = neighbors[0];
      for (const n of neighbors) if (dist(venue, n.coords).miles < dist(venue, nearest.coords).miles) nearest = n;
      const nearestMiles = dist(venue, nearest.coords).miles;
      const withinRadius = nearestMiles <= routeRadiusMiles;
      if (withinRadius) anyWithinRadius = true;
      if (!withinRadius) continue;

      // Timing: enforced only when an adjacent anchor's window is KNOWN. The incremental drive time the
      // detour adds must stay within tolerance. Unknown window → allowed, but flagged unverified.
      const windowKnown = neighbors.some((n) => n.windowKnown);
      const timingFeasible = !windowKnown || incMin <= timingToleranceMinutes;
      if (!timingFeasible) {
        anyWindowBlocked = true;
        continue;
      }

      const cand: Candidate = { inc, incMin, anchor: nearest, truckId: trip.truckId, timingVerified: windowKnown };
      if (best === null || cand.inc < best.inc || (cand.inc === best.inc && cand.anchor.id.localeCompare(best.anchor.id) < 0)) {
        best = cand;
      }
    }
  }

  if (best && best.inc < whMiles) {
    const billable = round2(Math.max(0, best.inc));
    const savings = round2(whMiles - billable);
    reasons.push(
      `Shared with "${best.anchor.label}"${best.truckId ? ` on ${best.truckId}` : ""} on the same date: the new stop adds ${billable} mi to that trip vs ${whMiles} mi for a dedicated run (saves ${savings} mi).`,
    );
    if (!best.timingVerified) {
      reasons.push("That job is a signed booking not yet on a route, so its time window is unknown — the timing of this share is ASSUMED, not verified.");
    }
    return {
      mode: "ROUTE_OPTIMIZED",
      warehouseMiles: whMiles,
      billableMiles: billable,
      incrementalMiles: billable,
      savingsMiles: savings,
      anchor: { id: best.anchor.id, label: best.anchor.label, truckId: best.truckId, source: best.anchor.source, timingVerified: best.timingVerified },
      anchorsConsidered: anchors.length,
      reasons,
    };
  }

  // DEDICATED — other jobs exist, but none can beat a standalone trip. Say WHY so the rep sees it was checked.
  if (!anyWithinRadius) {
    reasons.push(`${anchors.length} other signed job(s) that day, but none within ${routeRadiusMiles} mi of this venue — priced as a dedicated trip.`);
  } else if (anyWindowBlocked) {
    reasons.push(`${anchors.length} other signed job(s) nearby that day, but inserting this stop would push a scheduled window past the ${timingToleranceMinutes}-min tolerance — priced as a dedicated trip.`);
  } else {
    reasons.push(`${anchors.length} other signed job(s) that day, but sharing a route would not shorten the drive vs a dedicated run — priced as a dedicated trip.`);
  }
  return { mode: "DEDICATED", warehouseMiles: whMiles, billableMiles: whMiles, incrementalMiles: best ? best.inc : null, savingsMiles: null, anchor: null, anchorsConsidered: anchors.length, reasons };
}
