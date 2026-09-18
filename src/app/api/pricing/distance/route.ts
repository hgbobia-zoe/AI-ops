// Driving distance from the Zoe warehouse to an event address, for the delivery calculator. Reuses the
// ETA stack (Google Directions when GOOGLE_MAPS_API_KEY is set, else keyless OSRM) so the miles match
// what the driver actually drives. Best-effort: returns miles:null if it can't resolve — the calculator
// then lets the rep type the miles in by hand.

import { NextResponse } from "next/server";
import { geocode, driveTime } from "@/lib/eta/geo";
import { metersToMiles } from "@/lib/pricing/delivery";

export const dynamic = "force-dynamic";

// Fixed origin: Zoe Event Rentals warehouse (North Bethesda, MD). Coordinates are hardcoded because the
// origin never moves and a suite-numbered address ("#4A") trips keyless geocoders — so only the venue
// needs geocoding, and the warehouse leg can't silently fail.
export const WAREHOUSE_ADDRESS = "12712 Rock Creek Mill Rd #4A, North Bethesda, MD 20852";
const WAREHOUSE_COORDS = { lat: 39.0638628, lng: -77.1127462 };

export async function GET(req: Request): Promise<NextResponse> {
  const address = (new URL(req.url).searchParams.get("address") ?? "").trim();
  if (!address) return NextResponse.json({ error: "address_required" }, { status: 400 });

  const to = await geocode(address);
  if (!to) return NextResponse.json({ miles: null, reason: "could_not_geocode" });

  const drive = await driveTime(WAREHOUSE_COORDS, to);
  if (!drive?.meters) return NextResponse.json({ miles: null, reason: "no_route" });

  return NextResponse.json({ miles: Math.round(metersToMiles(drive.meters) * 10) / 10, warehouse: WAREHOUSE_ADDRESS });
}
