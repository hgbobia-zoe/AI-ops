// Read endpoint for the tablet's current-route view.
//
// This is the migration seam: today it serves mock data (M1); at M2 it reads the
// Zapier `Routes`/`Stops` tables; at v2 it can read Supabase — all behind the same
// response contract, so the client never changes.

import { NextResponse } from "next/server";
import { serverConfig } from "@/lib/config";
import { mockRoute } from "@/lib/mockData";
import type { Route } from "@/lib/types";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const truckId = url.searchParams.get("truckId");
  const date = url.searchParams.get("date") ?? today();

  if (!truckId) {
    return NextResponse.json({ error: "missing_truckId" }, { status: 400 });
  }

  if (serverConfig.useMockData()) {
    const route: Route = mockRoute(truckId, date);
    return NextResponse.json({ route }, { headers: { "cache-control": "no-store" } });
  }

  // TODO(M2): read Routes/Stops from Zapier Tables REST using serverConfig
  // credentials, then map to the Route shape. Until then this branch is unused
  // because useMockData() is true whenever no Tables API key is configured.
  return NextResponse.json(
    { error: "live_data_not_configured" },
    { status: 501 },
  );
}
