// Read endpoint for the tablet's current-route view. Reads from SQLite.
// `route: null` means no route started yet → the tablet shows the Start Route screen.

import { NextResponse } from "next/server";
import { getRoute } from "@/lib/db/repo";

export async function GET(req: Request) {
  const truckId = new URL(req.url).searchParams.get("truckId");
  if (!truckId) {
    return NextResponse.json({ error: "missing_truckId" }, { status: 400 });
  }
  return NextResponse.json(
    { route: getRoute(truckId) },
    { headers: { "cache-control": "no-store" } },
  );
}
