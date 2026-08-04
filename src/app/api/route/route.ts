// Read endpoint for the tablet's current-route view.
//
// Reads the server route store, which the ingestion job populates on "Start
// Route" (mock now; Goodshuffle via Computer Use at M2; Zapier Tables/Supabase
// later — all behind this same contract, so the client never changes).
//
// `route: null` means no route has been started for this truck yet → the tablet
// shows the Start Route screen.

import { NextResponse } from "next/server";
import { getRoute } from "@/lib/ingest/routeStore";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const truckId = url.searchParams.get("truckId");

  if (!truckId) {
    return NextResponse.json({ error: "missing_truckId" }, { status: 400 });
  }

  const route = getRoute(truckId);
  return NextResponse.json(
    { route },
    { headers: { "cache-control": "no-store" } },
  );
}
