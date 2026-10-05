// Driving distance from the Zoe warehouse to an event address, for the delivery calculator. Reuses the
// ETA stack (Google Directions when GOOGLE_MAPS_API_KEY is set, else keyless OSRM) so the miles match
// what the driver actually drives. Best-effort: returns miles:null if it can't resolve — the calculator
// then lets the rep type the miles in by hand.

import { NextResponse } from "next/server";
import { geocode, driveTime } from "@/lib/eta/geo";
import { metersToMiles } from "@/lib/pricing/delivery";
import { WAREHOUSE_ADDRESS, WAREHOUSE_COORDS } from "@/lib/pricing/warehouse";

export const dynamic = "force-dynamic";

// Fixed origin: the Zoe warehouse (see src/lib/pricing/warehouse.ts). Only the venue needs geocoding.

export async function GET(req: Request): Promise<NextResponse> {
  const address = (new URL(req.url).searchParams.get("address") ?? "").trim();
  if (!address) return NextResponse.json({ error: "address_required" }, { status: 400 });

  const to = await geocode(address);
  if (!to) return NextResponse.json({ miles: null, reason: "could_not_geocode" });

  const drive = await driveTime(WAREHOUSE_COORDS, to);
  if (!drive?.meters) return NextResponse.json({ miles: null, reason: "no_route" });

  return NextResponse.json({ miles: Math.round(metersToMiles(drive.meters) * 10) / 10, warehouse: WAREHOUSE_ADDRESS });
}
