// Admin utility: list the GPS TrackIt units (vehicles) so their ids can be mapped
// to our truckIds via GPSTRACKIT_UNITS_JSON. Returns null when GPS TrackIt isn't
// configured. Read-only.

import { NextResponse } from "next/server";
import { listUnits } from "@/lib/eta/zonar";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ units: await listUnits() });
}
