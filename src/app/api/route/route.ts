// Read endpoint for the tablet's current-route view. Reads from SQLite.
// `route: null` means no route started yet → the tablet shows the Start Route screen.

import { NextResponse } from "next/server";
import { getActiveRouteForTruck } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const truckId = new URL(req.url).searchParams.get("truckId");
  if (!truckId) {
    return NextResponse.json({ error: "missing_truckId" }, { status: 400 });
  }
  // TODAY's route for this truck (not the latest-written one, which the multi-week pull can make a
  // future day). Keeps the driver kiosk locked to the day they're actually running.
  return NextResponse.json(
    { route: getActiveRouteForTruck(truckId) },
    { headers: { "cache-control": "no-store" } },
  );
}
