// Vehicle list for the truck-select screen. Mock in M1; Zapier `Vehicles` table later.

import { NextResponse } from "next/server";
import { serverConfig } from "@/lib/config";
import { MOCK_VEHICLES } from "@/lib/mockData";

export async function GET() {
  if (serverConfig.useMockData()) {
    return NextResponse.json({ vehicles: MOCK_VEHICLES.filter((v) => v.active) });
  }
  // TODO(M2): read the Vehicles table from Zapier Tables.
  return NextResponse.json({ error: "live_data_not_configured" }, { status: 501 });
}
