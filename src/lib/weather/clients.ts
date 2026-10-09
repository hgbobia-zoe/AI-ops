// Network clients for weather — US Census geocoder + Open-Meteo forecast. Both are FREE and need no API
// key. Every fetch is injectable (pass a `fetch`-like) so unit tests never touch the network, has a short
// timeout, and is wrapped so a failure becomes a typed null/UNAVAILABLE — it NEVER throws into a render.

import type { Forecast, GeoPoint } from "./types";

/** A minimal fetch-like, so tests can inject a stub. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const DEFAULT_TIMEOUT_MS = 6000;

/** Run an injected fetch with a short timeout; resolves to null on any failure (never throws). */
async function safeJson(
  doFetch: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── US Census geocoder (onelineaddress) ───────────────────────────────────────────────────────────────
// https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=...&benchmark=Public_AR_Current&format=json
interface CensusResponse {
  result?: { addressMatches?: Array<{ coordinates?: { x?: number; y?: number } }> };
}

export const CENSUS_GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

/** Geocode a US address → {lat,lon}, or null when it can't be resolved (→ LOCATION_UNKNOWN upstream).
 *  Census returns coordinates as x=lon, y=lat. */
export async function geocodeAddress(
  address: string,
  opts: { fetch: FetchLike; timeoutMs?: number },
): Promise<GeoPoint | null> {
  const a = address.trim();
  if (!a) return null;
  const url =
    `${CENSUS_GEOCODER_URL}?address=${encodeURIComponent(a)}` +
    `&benchmark=Public_AR_Current&format=json`;
  const json = (await safeJson(opts.fetch, url, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)) as CensusResponse | null;
  const match = json?.result?.addressMatches?.[0]?.coordinates;
  if (!match || typeof match.x !== "number" || typeof match.y !== "number") return null;
  return { lat: match.y, lon: match.x };
}

// ── Open-Meteo daily forecast ─────────────────────────────────────────────────────────────────────────
// https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&daily=...&start_date=..&end_date=..
interface OpenMeteoResponse {
  daily?: {
    time?: string[];
    precipitation_probability_max?: (number | null)[];
    precipitation_sum?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    windspeed_10m_max?: (number | null)[];
    weathercode?: (number | null)[];
  };
}

export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

const DAILY_VARS = [
  "precipitation_probability_max",
  "precipitation_sum",
  "temperature_2m_max",
  "temperature_2m_min",
  "windspeed_10m_max",
  "weathercode",
].join(",");

/** Fetch the daily forecast for one date + location. Returns a real Forecast, or null when the service
 *  failed or returned no row for the date (→ UNAVAILABLE upstream). Units: °F / mph / inches. */
export async function fetchForecast(
  point: GeoPoint,
  dateISO: string,
  opts: { fetch: FetchLike; timeoutMs?: number },
): Promise<Forecast | null> {
  const url =
    `${OPEN_METEO_URL}?latitude=${point.lat}&longitude=${point.lon}` +
    `&daily=${DAILY_VARS}` +
    `&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch` +
    `&timezone=auto&start_date=${dateISO}&end_date=${dateISO}`;
  const json = (await safeJson(opts.fetch, url, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)) as OpenMeteoResponse | null;
  const d = json?.daily;
  if (!d || !Array.isArray(d.time) || d.time.length === 0) return null;
  // Open-Meteo echoes the requested date in daily.time[0]; guard the index.
  const i = d.time.indexOf(dateISO) >= 0 ? d.time.indexOf(dateISO) : 0;
  const at = (arr?: (number | null)[]): number | null => (arr && arr[i] != null ? (arr[i] as number) : null);
  return {
    dateISO,
    lat: point.lat,
    lon: point.lon,
    precipitationProbabilityMax: at(d.precipitation_probability_max),
    precipitationSum: at(d.precipitation_sum),
    temperatureMax: at(d.temperature_2m_max),
    temperatureMin: at(d.temperature_2m_min),
    windspeedMax: at(d.windspeed_10m_max),
    weathercode: at(d.weathercode),
  };
}
