// Today's operations map — returns today's stops with geocoded coordinates so the Command Center can plot
// route pins. Geocoding is cached (in-process, per address) so repeat loads are cheap; a stop whose
// address can't be geocoded is simply omitted (never a fabricated location). Staff-gated by the proxy.

import { NextResponse } from "next/server";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import { geocode } from "@/lib/eta/geo";
import { getTruckPosition, zonarConfigured } from "@/lib/eta/zonar";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi } from "@/lib/auth/roles"; // any signed staff (same bar as the rest of the console)

export const dynamic = "force-dynamic";

const DONE = new Set(["Completed", "Returned"]);
const ACTIVE = new Set(["EnRoute", "Arrived", "HeadingBack"]);

export interface MapPin {
  truckId: string;
  seq: number;
  lat: number;
  lng: number;
  label: string;
  kind: "delivery" | "pickup";
  state: "done" | "active" | "waiting";
}

export interface TruckMarker {
  truckId: string;
  label: string;
  lat: number;
  lng: number;
  ts: string | null;
}

export async function GET(): Promise<NextResponse> {
  if (!canViewAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const today = todayInOpsTz();
  const vehicles = getActiveVehicles();
  const routes = vehicles.flatMap((t) => getRoutesForDate(t.truckId, today));

  // Collect addressed stops, then geocode (cached) in parallel — bounded to keep the free geocoder happy.
  const stops = routes
    .flatMap((r) => (r.stops ?? []).map((s) => ({ truckId: r.truckId, s })))
    .filter((x) => (x.s.address ?? "").trim().length > 0)
    .slice(0, 24);

  const pins: MapPin[] = [];
  await Promise.all(
    stops.map(async ({ truckId, s }) => {
      const loc = await safeGeocode(s.address);
      if (!loc) return;
      pins.push({
        truckId,
        seq: s.sequence,
        lat: loc.lat,
        lng: loc.lng,
        label: s.custName || s.address,
        kind: s.kind === "pickup" ? "pickup" : "delivery",
        state: DONE.has(s.state) ? "done" : ACTIVE.has(s.state) ? "active" : "waiting",
      });
    }),
  );
  pins.sort((a, b) => a.truckId.localeCompare(b.truckId) || a.seq - b.seq);

  // Live truck positions from Ignition / Zonar (GPS TrackIt) — server-side, key-gated. Empty when the GPS
  // key isn't set; a truck with no current fix is simply omitted (never a fabricated position).
  const gpsOn = zonarConfigured();
  const trucks: TruckMarker[] = [];
  if (gpsOn) {
    await Promise.all(
      vehicles.map(async (v) => {
        const pos = await safePos(v.truckId);
        if (pos) trucks.push({ truckId: v.truckId, label: v.name, lat: pos.lat, lng: pos.lng, ts: pos.ts ?? null });
      }),
    );
  }

  return NextResponse.json({ pins, trucks, gpsConfigured: gpsOn, geocoded: pins.length, stops: stops.length });
}

async function safePos(truckId: string): Promise<{ lat: number; lng: number; ts?: string } | null> {
  try {
    return await getTruckPosition(truckId);
  } catch {
    return null;
  }
}

async function safeGeocode(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    return await geocode(address);
  } catch {
    return null;
  }
}
