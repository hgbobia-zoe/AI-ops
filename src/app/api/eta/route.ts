// Live ETA endpoint — real truck location (Zonar) → real drive-time ETA to a stop.
// The driver app polls this for the active stop; the customer /track page computes
// it server-side. Returns { eta: null } when Zonar isn't configured (caller falls
// back to the planned ETA).

import { NextResponse } from "next/server";
import { getStop } from "@/lib/db/repo";
import { computeLiveEta } from "@/lib/eta/liveEta";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const truckId = searchParams.get("truckId");
  const stopId = searchParams.get("stopId");
  if (!truckId || !stopId) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }
  const stop = getStop(stopId);
  if (!stop) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const eta = await computeLiveEta(truckId, stop);
  return NextResponse.json({ eta });
}
