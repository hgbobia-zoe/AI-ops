// Server-side driving-distance provider for the route-aware pricing engine. OSRM (keyless) is public and
// rate-limited, so every RESOLVED pair is cached across requests (a global Map, like geo.ts's geocode
// cache) and the number of live lookups per quote is BOUNDED. The pure engine (routeOptimize) wants a
// SYNCHRONOUS dist(a,b); so we pre-resolve every point pair it will query (routeOptimize.neededPairs), then
// hand it a closure that reads the prefilled table. Pairs are treated as symmetric (driving back is about
// the same as driving there) to halve the lookups.
//
// Only successes are cached. A routing failure is NEVER cached: caching it made every later recalculation
// silently reuse the straight-line estimate AND drop the "could not be verified" warning, so the same
// quote could show a different price with no flag. A failure is retried on the next quote instead.

import { driveTime, type LatLng } from "@/lib/eta/geo";
import { metersToMiles } from "./delivery";
import { pricingDeparture } from "./warehouse";
import { haversineMiles, type DistanceFn, type DistanceResult } from "./routeOptimize";

export { haversineMiles };

const g = globalThis as unknown as { __zoeDriveCache?: Map<string, DistanceResult | null> };
const cache = (g.__zoeDriveCache ??= new Map<string, DistanceResult | null>());

const coordKey = (p: LatLng): string => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
function pairKey(a: LatLng, b: LatLng): string {
  const [x, y] = [coordKey(a), coordKey(b)].sort();
  return `${x}|${y}`;
}

const same = (a: LatLng, b: LatLng): boolean => coordKey(a) === coordKey(b);

/** A cached, resolved pair (null cache entries from older builds are treated as not resolved). */
function cachedPair(a: LatLng, b: LatLng): DistanceResult | null {
  return cache.get(pairKey(a, b)) ?? null;
}

/** One driving distance (miles + minutes), cached on success; null when routing failed (not cached). */
export async function cachedDrive(a: LatLng, b: LatLng): Promise<DistanceResult | null> {
  if (same(a, b)) return { miles: 0, minutes: 0 };
  const hit = cachedPair(a, b);
  if (hit) return hit;
  const dt = await driveTime(a, b, { departAt: pricingDeparture() });
  const res: DistanceResult | null =
    dt && dt.meters != null && Number.isFinite(dt.meters) ? { miles: metersToMiles(dt.meters), minutes: dt.seconds / 60 } : null;
  if (res) cache.set(pairKey(a, b), res);
  return res;
}

/**
 * Pre-resolve driving distances for exactly `pairs` (bounded by MAX_CALLS live lookups; cache hits are
 * free) and return a synchronous DistanceFn for the engine. A pair we couldn't resolve (routing failure or
 * budget exhausted) falls back to a straight-line estimate so the engine never NaNs, and is counted in
 * `failures` on THIS quote and every later one until it resolves, so the caller can flag the result.
 */
export async function buildDistanceFn(pairs: Array<[LatLng, LatLng]>): Promise<{ dist: DistanceFn; failures: number }> {
  const MAX_CALLS = 60;
  const seen = new Set<string>();
  const failed = new Set<string>();
  let liveCalls = 0;
  for (const [a, b] of pairs) {
    if (same(a, b)) continue;
    const k = pairKey(a, b);
    if (seen.has(k)) continue;
    seen.add(k);
    if (cachedPair(a, b)) continue; // already resolved, free
    if (liveCalls >= MAX_CALLS) {
      failed.add(k);
      continue;
    }
    liveCalls++;
    const res = await cachedDrive(a, b);
    if (!res) failed.add(k);
  }
  const dist: DistanceFn = (a, b) => {
    if (same(a, b)) return { miles: 0, minutes: 0 };
    const r = cachedPair(a, b);
    if (r) return r;
    const h = haversineMiles(a, b);
    return { miles: h, minutes: (h / 30) * 60 }; // about 30 mph when a pair couldn't be routed
  };
  return { dist, failures: failed.size };
}
