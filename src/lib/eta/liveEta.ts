// Live ETA — the real drive-time ETA. The truck's current position comes from GPS
// TrackIt (the API behind Zonar Ignition); the drive time to the stop is computed
// here (geocode the address → route). Used by the customer /track page, the driver
// app (via /api/eta), and the outgoing Quo SMS.
//
// On-demand + cached: GPS TrackIt's plan caps API calls (~800/day), so we only fetch
// when an ETA is actually shown/sent and cache the result briefly. Returns null when
// GPS TrackIt isn't configured or any step fails — callers fall back to the planned
// ETA from Goodshuffle.

import { getTruckPosition, zonarConfigured, type TruckPosition } from "./zonar";
import { driveTime, geocode } from "./geo";

export interface LiveEta {
  etaText: string; // arrival clock time, e.g. "2:47 PM"
  minutesAway: number;
  distanceMiles?: number;
  truck?: TruckPosition; // for a "see the truck" map link
  source: "gpstrackit";
  computedAt: string; // ISO8601
}

export function liveEtaEnabled(): boolean {
  return zonarConfigured();
}

// Short in-memory cache so repeated views / polls don't each burn an API call.
const CACHE_MS = Number(process.env.ETA_CACHE_SECONDS || 120) * 1000;
const g = globalThis as unknown as { __etaCache?: Map<string, { at: number; eta: LiveEta }> };
const cache = (g.__etaCache ??= new Map());

export async function computeLiveEta(
  truckId: string,
  stop: { address?: string | null },
): Promise<LiveEta | null> {
  if (!zonarConfigured() || !stop.address) return null;

  const key = `${truckId}|${stop.address}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.eta;

  const truck = await getTruckPosition(truckId);
  if (!truck) return null;

  const dest = await geocode(stop.address);
  if (!dest) return null;

  const dt = await driveTime({ lat: truck.lat, lng: truck.lng }, dest);
  if (!dt) return null;

  const minutes = Math.max(1, Math.round(dt.seconds / 60));
  const arrival = new Date(Date.now() + dt.seconds * 1000);
  const tz = process.env.ETA_TIMEZONE || "America/New_York";

  const eta: LiveEta = {
    etaText: arrival.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    }),
    minutesAway: minutes,
    distanceMiles: dt.meters ? Math.round((dt.meters / 1609.34) * 10) / 10 : undefined,
    truck,
    source: "gpstrackit",
    computedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), eta });
  return eta;
}
