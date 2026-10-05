// Server-side driving-distance provider for the route-aware pricing engine. OSRM (keyless) is public and
// rate-limited, so every pair is CACHED across requests (a global Map, like geo.ts's geocode cache) and
// the number of live lookups per quote is BOUNDED. The pure engine (routeOptimize) wants a SYNCHRONOUS
// dist(a,b); so we pre-resolve every point-pair it will query, then hand it a closure that reads the
// prefilled table. Pairs are treated as symmetric (driving back ≈ driving there) to halve the lookups.

import { driveTime, type LatLng } from "@/lib/eta/geo";
import { metersToMiles } from "./delivery";
import type { DistanceFn, DistanceResult } from "./routeOptimize";

const g = globalThis as unknown as { __zoeDriveCache?: Map<string, DistanceResult | null> };
const cache = (g.__zoeDriveCache ??= new Map<string, DistanceResult | null>());

const coordKey = (p: LatLng): string => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
function pairKey(a: LatLng, b: LatLng): string {
  const [x, y] = [coordKey(a), coordKey(b)].sort();
  return `${x}|${y}`;
}

const same = (a: LatLng, b: LatLng): boolean => coordKey(a) === coordKey(b);

/** One cached driving distance (miles + minutes), or null when OSRM couldn't route it. */
export async function cachedDrive(a: LatLng, b: LatLng): Promise<DistanceResult | null> {
  if (same(a, b)) return { miles: 0, minutes: 0 };
  const k = pairKey(a, b);
  if (cache.has(k)) return cache.get(k)!;
  const dt = await driveTime(a, b);
  const res: DistanceResult | null =
    dt && dt.meters != null && Number.isFinite(dt.meters) ? { miles: metersToMiles(dt.meters), minutes: dt.seconds / 60 } : null;
  cache.set(k, res);
  return res;
}

// Straight-line (haversine) miles — a cheap prefilter and a safe fallback. Straight-line ≤ driving, so a
// point beyond the radius by air is beyond it by road too (sound to exclude on this before any OSRM call).
export function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.7613; // Earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Pre-resolve driving distances for every pair among `points` (bounded by MAX_CALLS live OSRM lookups —
 * cache hits are free) and return a synchronous DistanceFn for the engine. A pair we couldn't resolve
 * (OSRM failure or budget exhausted) falls back to a haversine estimate so the engine never NaNs; the
 * count of such fallbacks is returned so the caller can flag the result as partially unverified.
 */
export async function buildDistanceFn(points: LatLng[]): Promise<{ dist: DistanceFn; failures: number }> {
  const MAX_CALLS = 60;
  // Dedupe points by rounded key.
  const uniq: LatLng[] = [];
  const seen = new Set<string>();
  for (const p of points) {
    const k = coordKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }
  let failures = 0;
  let liveCalls = 0;
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const k = pairKey(uniq[i], uniq[j]);
      if (cache.has(k)) continue; // already resolved — free
      if (liveCalls >= MAX_CALLS) {
        failures++;
        continue;
      }
      liveCalls++;
      const res = await cachedDrive(uniq[i], uniq[j]); // writes the cache
      if (!res) failures++;
    }
  }
  const dist: DistanceFn = (a, b) => {
    if (same(a, b)) return { miles: 0, minutes: 0 };
    const r = cache.get(pairKey(a, b));
    if (r) return r;
    const h = haversineMiles(a, b);
    return { miles: h, minutes: (h / 30) * 60 }; // ~30 mph fallback when a pair couldn't be routed
  };
  return { dist, failures };
}
