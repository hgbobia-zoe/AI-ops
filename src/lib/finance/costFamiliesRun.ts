// FI Stage 5 — derived cost-families recompute (the WIRING glue). Called from the risk scan right after
// saveDerivedLabor, so the non-labor families (transport/fuel, extra-trip, overtime premium) recompute
// idempotently on the same cadence as attributed labor. This module is the impure boundary: it reads the
// DB + geocodes stop addresses; the actual math lives in the PURE, tested estimators in costFamilies.ts.
//
// HONESTY: every family emits a row ONLY when its input exists. A stop that can't be geocoded gets no
// transport/extra-trip estimate (UNAVAILABLE, never 0). Overtime attaches only when an OT period overlaps
// the scanned window AND the worker has attributed labor in it. The whole recompute is wrapped by the
// caller in try/catch — a failure here must never break the core scan.

import { costFamiliesConfig } from "./config";
import { estimateTransportCost, detectExtraTrips, estimateOvertimePremium, type TransportLeg, type TripRecord } from "./costFamilies";
import {
  getCostFamilyStops,
  getProjectFirstTripDates,
  getOvertimeByWorker,
  getWorkerLaborShares,
  saveDerivedTransportCosts,
  saveDerivedOvertimeCosts,
  type CostFamilyStop,
} from "@/lib/db/repo";
import { geocode, type LatLng } from "@/lib/eta/geo";
import { WAREHOUSE_COORDS } from "@/lib/pricing/warehouse";
import { haversineMiles } from "@/lib/pricing/routeDistance";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Round-trip (warehouse → site → warehouse) straight-line miles for an address, or null when it can't be
 *  geocoded. Straight-line is a conservative (under-)estimate of driving distance — the row is ESTIMATED
 *  and says so. Geocodes are cached process-wide (geo.ts), so repeat scans are cheap. */
async function roundTripMiles(address: string, geo: (a: string) => Promise<LatLng | null>): Promise<number | null> {
  try {
    const site = await geo(address);
    if (!site) return null;
    return round2(2 * haversineMiles(WAREHOUSE_COORDS, site));
  } catch {
    return null;
  }
}

export interface RecomputeResult {
  transportRows: number;
  extraTripRows: number;
  overtimeRows: number;
  skipped?: string;
}

/** Recompute + persist the derived cost families for the given scanned days. Pure-glue: deterministic
 *  given the DB + geocode results. `geo` is injectable for tests; defaults to the real geocoder. */
export async function recomputeCostFamilies(days: string[], geo: (a: string) => Promise<LatLng | null> = geocode): Promise<RecomputeResult> {
  const cfg = costFamiliesConfig();
  if (!cfg.derivedEnabled) return { transportRows: 0, extraTripRows: 0, overtimeRows: 0, skipped: "disabled" };
  const scanDays = [...new Set(days)].filter(Boolean);
  if (scanDays.length === 0) return { transportRows: 0, extraTripRows: 0, overtimeRows: 0, skipped: "no-days" };

  // ── Resolve per-(route,event,day) and per-trip distances once (dedupe addresses). ──
  const stops = getCostFamilyStops(scanDays);
  const milesByAddress = new Map<string, number | null>();
  for (const s of stops) {
    if (!milesByAddress.has(s.address)) milesByAddress.set(s.address, await roundTripMiles(s.address, geo));
  }
  const milesOf = (s: CostFamilyStop): number | null => milesByAddress.get(s.address) ?? null;

  // ── Transport/fuel (G6): one leg per (routeId, day, eventId), representative (lowest-sequence) stop. ──
  // group key → { routeId, day, eventId, miles }
  const legSeen = new Set<string>();
  const legsByRouteDay = new Map<string, { routeId: string; day: string; legs: TransportLeg[] }>();
  for (const s of stops) {
    const legKey = `${s.routeId}|${s.day}|${s.txId}`;
    if (legSeen.has(legKey)) continue; // stops are ordered by sequence → first wins (representative)
    legSeen.add(legKey);
    const rdKey = `${s.routeId}|${s.day}`;
    const bucket = legsByRouteDay.get(rdKey) ?? { routeId: s.routeId, day: s.day, legs: [] };
    bucket.legs.push({ eventId: s.txId, roundTripMiles: milesOf(s) });
    legsByRouteDay.set(rdKey, bucket);
  }
  const transportRows = [...legsByRouteDay.values()].flatMap((b) =>
    estimateTransportCost({ routeId: b.routeId, day: b.day, costPerMile: cfg.transportCostPerMile, legs: b.legs }),
  );

  // ── Extra-trip (G7): one trip per (eventId, day, kind) among the scanned days, vs each project's
  //    first-of-kind date across ALL history. ──
  const tripSeen = new Set<string>();
  const trips: TripRecord[] = [];
  for (const s of stops) {
    const tripKey = `${s.txId}|${s.day}|${s.kind}`;
    if (tripSeen.has(tripKey)) continue;
    tripSeen.add(tripKey);
    trips.push({ eventId: s.txId, routeId: s.routeId, day: s.day, kind: s.kind, roundTripMiles: milesOf(s) });
  }
  const firstDates = getProjectFirstTripDates(trips.map((t) => t.eventId));
  const extraTripRows = detectExtraTrips({
    trips,
    firstKindDate: (eventId, kind) => firstDates.get(`${eventId}|${kind}`) ?? null,
    costPerMile: cfg.transportCostPerMile,
  });

  saveDerivedTransportCosts(scanDays, [...transportRows, ...extraTripRows]);

  // ── Overtime premium (G8): OT periods overlapping the scanned window × each worker's attributed labor.
  //    Rarely fires in a forward scan (payroll OT lands after the fact), but correct when it does. ──
  const start = scanDays[0];
  const end = scanDays[scanDays.length - 1];
  const otWorkers = getOvertimeByWorker(start, end);
  const otRows = [];
  const otScopes: { workerRef: string; periodStart: string }[] = [];
  for (const w of otWorkers) {
    otScopes.push({ workerRef: w.workerRef, periodStart: w.periodStart });
    const shares = getWorkerLaborShares(w.workerRef, w.periodStart, w.periodEnd);
    const rate = shares.reduce<number | null>((acc, s) => (s.rate != null ? Math.max(acc ?? 0, s.rate) : acc), null);
    otRows.push(
      ...estimateOvertimePremium({
        workerRef: w.workerRef,
        periodStart: w.periodStart,
        periodEnd: w.periodEnd,
        overtimeHours: w.overtimeHours,
        rate,
        premiumMultiplier: cfg.overtimePremiumMultiplier,
        shares: shares.map((s) => ({ eventId: s.eventId, laborCost: s.laborCost })),
      }),
    );
  }
  if (otScopes.length > 0) saveDerivedOvertimeCosts(otScopes, otRows);

  return { transportRows: transportRows.length, extraTripRows: extraTripRows.length, overtimeRows: otRows.length };
}
