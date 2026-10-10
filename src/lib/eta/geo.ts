// Geocoding (address → lat/lng) and drive-time routing (from → to → seconds).
//
// GEOCODE provider order (first hit wins):
//   1. Google Geocoding — only when GOOGLE_MAPS_API_KEY is set (best coverage; also unlocks the
//      traffic-aware drive times below). Optional.
//   2. US Census geocoder — keyless, free, excellent US street-address coverage. The default.
//   3. Nominatim (OpenStreetMap) — keyless last resort (non-US). Public + rate-limited and MISSES
//      many valid US addresses (new subdivisions etc.), so it is no longer primary: a Nominatim miss
//      used to leave the stop with NO coordinates → no Ignition etaLink minted → the customer "on the
//      way" text fell back to /track. Census fixes that for US addresses at no cost.
// DRIVE TIME: Google (traffic-aware) when keyed, else keyless OSRM.
//
// Everything is best-effort: a total miss returns null and the caller falls back to the planned ETA /
// the /track link. We cache ONLY successful geocodes, so a transient/one-off miss never poisons an
// address for the rest of the process's life.

import { alertOps } from "@/lib/notify/alert";

export interface LatLng {
  lat: number;
  lng: number;
}

// Geocoding is stable per address — cache across requests to avoid repeat calls
// (and to stay under the free OSM rate limits).
const g = globalThis as unknown as { __zoeGeocache?: Map<string, LatLng | null> };
const cache = (g.__zoeGeocache ??= new Map<string, LatLng | null>());

export async function geocode(address: string): Promise<LatLng | null> {
  const key = address?.trim();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key)!; // only successful geocodes are ever cached (see below)
  let result: LatLng | null = null;
  if (process.env.GOOGLE_MAPS_API_KEY) result = await geocodeGoogle(key);
  if (!result) result = await geocodeCensus(key);
  if (!result) result = await geocodeNominatim(key);
  // Cache ONLY a success. Caching a null here was a real bug: one transient miss (a rate-limit blip,
  // or an address a provider can't resolve) stuck for the whole process, so every later send for that
  // address silently used /track instead of the live Ignition link.
  if (result) cache.set(key, result);
  return result;
}

// US Census geocoder — keyless, free, strong US street-address coverage (the keyless default).
// US-only: a non-US address returns no match and falls through to Nominatim.
async function geocodeCensus(address: string): Promise<LatLng | null> {
  const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  try {
    const d = await (await fetch(url, { cache: "no-store" })).json();
    const c = d?.result?.addressMatches?.[0]?.coordinates;
    // Census returns x = longitude, y = latitude.
    return c && typeof c.y === "number" && typeof c.x === "number"
      ? { lat: Number(c.y), lng: Number(c.x) }
      : null;
  } catch {
    return null;
  }
}

async function geocodeGoogle(address: string): Promise<LatLng | null> {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", process.env.GOOGLE_MAPS_API_KEY!);
  try {
    const d = await (await fetch(url, { cache: "no-store" })).json();
    if (d?.status && d.status !== "OK" && d.status !== "ZERO_RESULTS") {
      void alertOps("Google Maps (geocode)", `${d.status}${d.error_message ? `: ${d.error_message}` : ""}`);
    }
    const loc = d?.results?.[0]?.geometry?.location;
    return loc ? { lat: Number(loc.lat), lng: Number(loc.lng) } : null;
  } catch (e) {
    void alertOps("Google Maps (geocode)", String(e));
    return null;
  }
}

async function geocodeNominatim(address: string): Promise<LatLng | null> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", address);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  try {
    const d = await (
      await fetch(url, {
        headers: { "User-Agent": "ZoeDispatch/1.0 (dispatch tracking)" },
        cache: "no-store",
      })
    ).json();
    const hit = Array.isArray(d) ? d[0] : null;
    return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
  } catch {
    return null;
  }
}

export interface DriveTime {
  seconds: number;
  meters?: number;
}

export async function driveTime(from: LatLng, to: LatLng): Promise<DriveTime | null> {
  return process.env.GOOGLE_MAPS_API_KEY
    ? driveTimeGoogle(from, to)
    : driveTimeOsrm(from, to);
}

async function driveTimeGoogle(from: LatLng, to: LatLng): Promise<DriveTime | null> {
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", `${from.lat},${from.lng}`);
  url.searchParams.set("destination", `${to.lat},${to.lng}`);
  url.searchParams.set("departure_time", "now"); // unlocks duration_in_traffic
  url.searchParams.set("key", process.env.GOOGLE_MAPS_API_KEY!);
  try {
    const d = await (await fetch(url, { cache: "no-store" })).json();
    if (d?.status && d.status !== "OK" && d.status !== "ZERO_RESULTS") {
      void alertOps("Google Maps (directions)", `${d.status}${d.error_message ? `: ${d.error_message}` : ""}`);
    }
    const leg = d?.routes?.[0]?.legs?.[0];
    const secs = leg?.duration_in_traffic?.value ?? leg?.duration?.value;
    return typeof secs === "number"
      ? { seconds: secs, meters: leg?.distance?.value }
      : null;
  } catch (e) {
    void alertOps("Google Maps (directions)", String(e));
    return null;
  }
}

async function driveTimeOsrm(from: LatLng, to: LatLng): Promise<DriveTime | null> {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  try {
    const d = await (await fetch(url, { cache: "no-store" })).json();
    const route = d?.routes?.[0];
    return route ? { seconds: Number(route.duration), meters: Number(route.distance) } : null;
  } catch {
    return null;
  }
}
