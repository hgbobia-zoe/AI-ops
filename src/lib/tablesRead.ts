// Client read helpers. The tablet reads its current route/vehicle list from our
// own API routes, which abstract the data source (mock now, Zapier Tables at M2).

"use client";

import type { Route, Vehicle } from "./types";

export async function fetchVehicles(): Promise<Vehicle[]> {
  const res = await fetch("/api/vehicles", { cache: "no-store" });
  if (!res.ok) throw new Error(`vehicles ${res.status}`);
  const data = (await res.json()) as { vehicles: Vehicle[] };
  return data.vehicles;
}

export async function fetchRoute(truckId: string): Promise<Route | null> {
  const res = await fetch(`/api/route?truckId=${encodeURIComponent(truckId)}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { route?: Route | null };
  return data.route ?? null;
}

/** Kick off Goodshuffle ingestion for a truck (Start Route). */
export async function triggerIngestion(truckId: string): Promise<void> {
  await fetch("/api/ingest-route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ truckId }),
  });
}
