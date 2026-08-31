// Server-side vehicle list. Trucks rarely change, so the list comes from the
// VEHICLES_JSON env var (a JSON array of { truckId, name, plate?, active? }),
// falling back to mock vehicles for local dev.

import { MOCK_VEHICLES } from "@/lib/mockData";
import type { Vehicle } from "@/lib/types";

export function getVehicles(): Vehicle[] {
  const raw = process.env.VEHICLES_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<Partial<Vehicle>>;
      const list = parsed
        .filter((v) => v.truckId && v.name)
        .map((v) => ({
          truckId: v.truckId!,
          name: v.name!,
          plate: v.plate,
          zonarDeviceId: v.zonarDeviceId,
          active: v.active !== false,
        }));
      if (list.length) return list;
    } catch {
      console.error("[vehicles] VEHICLES_JSON is not valid JSON — falling back to mock");
    }
  }
  return MOCK_VEHICLES;
}

export function getActiveVehicles(): Vehicle[] {
  return getVehicles().filter((v) => v.active);
}
