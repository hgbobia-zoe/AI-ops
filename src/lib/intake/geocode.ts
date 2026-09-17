// Server-side geocoding for the guided intake. Goodshuffle's delivery line items (base mileage delivery,
// Event Readiness) are rejected until the add carries a geocoded delivery location (venueAddress_* +
// latitude/longitude). The office pull runs as a bookmarklet where Google Maps JS may not be loaded, so we
// geocode HERE on the server (Fly can reach the internet; only Goodshuffle itself is Cloudflare-blocked)
// and pass coordinates down in the create_project payload.
//
// Provider: the US Census Geocoder — free, no API key, US-only, returns coordinates AND county (which the
// intake doesn't capture but Goodshuffle wants). Good fit for a DMV-area event-rental shop. Any failure
// (no match, network, timeout) returns null and the caller simply skips the location-dependent auto-adds —
// the shell is still created; those items are added by hand, exactly as before this was wired.

export interface GeoResult {
  latitude: string; // strings — Goodshuffle stores venueAddress_latitude/longitude as strings
  longitude: string;
  county: string; // e.g. "Montgomery" (no "County" suffix, matching Goodshuffle's venueCounty)
  matchedAddress: string;
}

/** Geocode a US street address via the Census geographies endpoint. Returns null if it can't be resolved
 *  (missing pieces, no match, or the service is unreachable) — never throws. */
export async function geocodeAddress(
  street: string,
  city: string,
  state: string,
  zip: string,
  timeoutMs = 6000,
): Promise<GeoResult | null> {
  const oneline = [street.trim(), city.trim(), state.trim(), zip.trim()].filter(Boolean).join(", ");
  // Need at least a street plus something to disambiguate it.
  if (!street.trim() || (!zip.trim() && !city.trim())) return null;

  const url =
    "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress" +
    `?address=${encodeURIComponent(oneline)}` +
    "&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as CensusResponse;
    const match = data?.result?.addressMatches?.[0];
    if (!match?.coordinates) return null;
    const county = match.geographies?.Counties?.[0]?.BASENAME?.trim();
    return {
      latitude: String(match.coordinates.y),
      longitude: String(match.coordinates.x),
      county: county || "",
      matchedAddress: match.matchedAddress || oneline,
    };
  } catch {
    return null; // aborted, offline, or malformed — degrade gracefully
  } finally {
    clearTimeout(timer);
  }
}

// Minimal shape of the Census geocoder response (only the fields we read).
interface CensusResponse {
  result?: {
    addressMatches?: Array<{
      matchedAddress?: string;
      coordinates?: { x: number; y: number }; // x = longitude, y = latitude
      geographies?: { Counties?: Array<{ BASENAME?: string }> };
    }>;
  };
}
