// Weather caches. Geocodes are STABLE (an address maps to one place forever) → a tiny durable table
// (geocode_cache, created in src/lib/db/index.ts). Forecasts CHANGE → a short in-process TTL cache only
// (never persisted). Both caches are injectable so the pure/orchestration tests run without a DB.

import { getDb } from "@/lib/db";
import type { GeoPoint } from "./types";

/** A geocode cache the orchestrator depends on. Default is DB-backed (below); tests inject a Map. A
 *  resolved:false row records a KNOWN-miss so we don't re-hit Census for an address that won't geocode. */
export interface GeocodeCache {
  get(key: string): { point: GeoPoint | null; resolved: boolean } | undefined;
  set(key: string, point: GeoPoint | null): void;
}

/** Normalize an address into a stable cache key (case/whitespace-insensitive). */
export function geocodeKey(address: string): string {
  return address.toLowerCase().replace(/\s+/g, " ").trim();
}

interface GeoRow {
  lat: number | null;
  lon: number | null;
  resolved: number;
}

/** The durable, DB-backed geocode cache (geocode_cache table). */
export const dbGeocodeCache: GeocodeCache = {
  get(key) {
    const row = getDb()
      .prepare("SELECT lat, lon, resolved FROM geocode_cache WHERE address_key = ?")
      .get(key) as GeoRow | undefined;
    if (!row) return undefined;
    const resolved = row.resolved === 1;
    return {
      resolved,
      point: resolved && row.lat != null && row.lon != null ? { lat: row.lat, lon: row.lon } : null,
    };
  },
  set(key, point) {
    getDb()
      .prepare(
        `INSERT INTO geocode_cache (address_key, lat, lon, resolved, updated_at)
         VALUES (@key, @lat, @lon, @resolved, @now)
         ON CONFLICT(address_key) DO UPDATE SET lat=@lat, lon=@lon, resolved=@resolved, updated_at=@now`,
      )
      .run({
        key,
        lat: point?.lat ?? null,
        lon: point?.lon ?? null,
        resolved: point ? 1 : 0,
        now: new Date().toISOString(),
      });
  },
};

// ── Forecast TTL cache (in-process only; forecasts are volatile and must never be persisted) ───────────
const FORECAST_TTL_MS = 3 * 60 * 60 * 1000; // 3h — forecasts for a date are stable enough within a few hours
const g = globalThis as unknown as { __weatherForecastCache?: Map<string, { at: number; value: unknown }> };

export function forecastCacheGet<T>(key: string, now: number = Date.now()): T | undefined {
  const cache = (g.__weatherForecastCache ??= new Map());
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > FORECAST_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function forecastCacheSet(key: string, value: unknown, now: number = Date.now()): void {
  const cache = (g.__weatherForecastCache ??= new Map());
  cache.set(key, { at: now, value });
}
