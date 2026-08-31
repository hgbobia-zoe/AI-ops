// Geocoding (address → lat/lng) and drive-time routing (from → to → seconds).
//
// Provider strategy:
//   • GOOGLE_MAPS_API_KEY set → Google Geocoding + Directions with
//     departure_time=now, i.e. a REAL, traffic-aware ETA. Use this in production.
//   • otherwise → keyless OpenStreetMap services (Nominatim geocode + OSRM route).
//     Fine for testing, but public and rate-limited (no traffic) — not for prod load.
//
// Everything is best-effort: any failure returns null and the caller falls back
// to the planned ETA.

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
  if (cache.has(key)) return cache.get(key)!;
  const result = process.env.GOOGLE_MAPS_API_KEY
    ? await geocodeGoogle(key)
    : await geocodeNominatim(key);
  cache.set(key, result);
  return result;
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
