// Vehicle list for the truck-select screen.
//
// Trucks rarely change, so instead of a live DB read the list comes from a config
// env var VEHICLES_JSON (a JSON array of { truckId, name, plate?, active? }).
// Falls back to mock vehicles for local dev. Keep this in sync with the Zapier
// `Vehicles` table your Zaps reference.

import { NextResponse } from "next/server";
import { getActiveVehicles } from "@/lib/vehicles";

export async function GET() {
  return NextResponse.json(
    { vehicles: getActiveVehicles() },
    { headers: { "cache-control": "no-store" } },
  );
}
