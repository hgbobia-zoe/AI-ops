// Vehicle list for the truck-select screen.
//
// Trucks rarely change, so instead of a live DB read the list comes from a config
// env var VEHICLES_JSON (a JSON array of { truckId, name, plate?, active? }).
// Falls back to mock vehicles for local dev. Keep this in sync with the Zapier
// `Vehicles` table your Zaps reference.

import { NextResponse } from "next/server";
import { MOCK_VEHICLES } from "@/lib/mockData";
import type { Vehicle } from "@/lib/types";

function configuredVehicles(): Vehicle[] | null {
  const raw = process.env.VEHICLES_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Array<Partial<Vehicle>>;
    return parsed
      .filter((v) => v.truckId && v.name)
      .map((v) => ({
        truckId: v.truckId!,
        name: v.name!,
        plate: v.plate,
        zonarDeviceId: v.zonarDeviceId,
        active: v.active !== false,
      }));
  } catch {
    console.error("[vehicles] VEHICLES_JSON is not valid JSON — falling back to mock");
    return null;
  }
}

export async function GET() {
  const vehicles = configuredVehicles() ?? MOCK_VEHICLES;
  return NextResponse.json(
    { vehicles: vehicles.filter((v) => v.active) },
    { headers: { "cache-control": "no-store" } },
  );
}
