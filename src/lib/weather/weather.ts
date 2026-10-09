// eventWeather — the honest orchestrator. Resolves a location (lat/lon directly, or by geocoding a US
// address through the cache), then fetches the Open-Meteo daily forecast for the event date. Returns a
// REAL Forecast only when the date is inside the forecast horizon AND the location resolved; otherwise a
// typed status (BEYOND_HORIZON | LOCATION_UNKNOWN | UNAVAILABLE). It NEVER fabricates a forecast and never
// throws into a render.
//
// All I/O is injectable (fetch + caches), so unit tests run with a mocked client and no DB/network.

import { fetchForecast, geocodeAddress, type FetchLike } from "./clients";
import {
  dbGeocodeCache,
  forecastCacheGet,
  forecastCacheSet,
  geocodeKey,
  type GeocodeCache,
} from "./cache";
import { OPEN_METEO_HORIZON_DAYS, type GeoPoint, type WeatherResult } from "./types";

/** Days from `now` (UTC date) to the event date. Negative = past. Mirrors risk/engine.ts daysUntil so
 *  proximity math is consistent across the platform. */
export function daysUntilDate(dateISO: string, now: Date): number {
  const [y, m, d] = dateISO.split("-").map(Number);
  if (!y || !m || !d) return NaN;
  const target = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / 86_400_000);
}

export interface EventWeatherInput {
  /** The event date (YYYY-MM-DD). Required — there is nothing to forecast without it. */
  dateISO: string | null | undefined;
  /** A resolved location, when the caller already has one (skips geocoding). */
  point?: GeoPoint | null;
  /** A US address/venue string to geocode when no point is given. */
  address?: string | null;
}

export interface EventWeatherDeps {
  fetch?: FetchLike;
  now?: Date;
  geocodeCache?: GeocodeCache;
  /** Override the geocoder (tests). Defaults to the Census client. */
  geocode?: (address: string, opts: { fetch: FetchLike }) => Promise<GeoPoint | null>;
  /** Override the forecast fetcher (tests). Defaults to the Open-Meteo client. */
  forecast?: (point: GeoPoint, dateISO: string, opts: { fetch: FetchLike }) => Promise<import("./types").Forecast | null>;
}

/** Resolve the event's weather, honestly. */
export async function eventWeather(input: EventWeatherInput, deps: EventWeatherDeps = {}): Promise<WeatherResult> {
  const date = (input.dateISO ?? "").trim();
  if (!date) return { status: "BEYOND_HORIZON" }; // no date → nothing to forecast (honest, non-fabricating)

  const now = deps.now ?? new Date();
  const days = daysUntilDate(date, now);
  // Open-Meteo forecasts only the next ~16 days; the past and the far future are out of reach.
  if (!Number.isFinite(days) || days < 0 || days > OPEN_METEO_HORIZON_DAYS) {
    return { status: "BEYOND_HORIZON" };
  }

  // The network calls default to the real clients; a missing global fetch (shouldn't happen on Node 22+)
  // degrades to UNAVAILABLE rather than throwing.
  const doFetch = deps.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (!doFetch) return { status: "UNAVAILABLE" };

  // 1) Resolve a location.
  let point = input.point ?? null;
  if (!point) {
    const address = (input.address ?? "").trim();
    if (!address) return { status: "LOCATION_UNKNOWN" };
    point = await resolveGeocode(address, doFetch, deps);
    if (!point) return { status: "LOCATION_UNKNOWN" };
  }

  // 2) Fetch the forecast (short-TTL cached by location+date).
  const fKey = `${point.lat.toFixed(4)},${point.lon.toFixed(4)}|${date}`;
  const cached = forecastCacheGet<import("./types").Forecast>(fKey, now.getTime());
  if (cached) return { status: "OK", forecast: cached };

  const fetchFc = deps.forecast ?? ((p: GeoPoint, dt: string, o: { fetch: FetchLike }) => fetchForecast(p, dt, o));
  const forecast = await fetchFc(point, date, { fetch: doFetch });
  if (!forecast) return { status: "UNAVAILABLE" };
  forecastCacheSet(fKey, forecast, now.getTime());
  return { status: "OK", forecast };
}

/** Geocode via the cache (durable), falling back to the live geocoder; records known-misses too. */
async function resolveGeocode(address: string, doFetch: FetchLike, deps: EventWeatherDeps): Promise<GeoPoint | null> {
  const cache = deps.geocodeCache ?? dbGeocodeCache;
  const key = geocodeKey(address);
  let hit: { point: GeoPoint | null; resolved: boolean } | undefined;
  try {
    hit = cache.get(key);
  } catch {
    hit = undefined; // a cache read failure must never break the lookup
  }
  if (hit) return hit.point; // resolved hit → point; known-miss → null (don't re-hit Census)

  const geocode = deps.geocode ?? ((a: string, o: { fetch: FetchLike }) => geocodeAddress(a, o));
  const point = await geocode(address, { fetch: doFetch });
  try {
    cache.set(key, point);
  } catch {
    // ignore cache write failures — we still return what we resolved
  }
  return point;
}
