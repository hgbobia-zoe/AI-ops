// In-memory mock route data for M1 (before Goodshuffle ingestion exists).
// Served by /api/route when USE_MOCK_DATA is on. This lets the full tablet flow
// be exercised end-to-end without any backend wired up.

import type { Route, Stop, Vehicle } from "./types";

export const MOCK_VEHICLES: Vehicle[] = [
  { truckId: "T-05", name: "Truck 5", plate: "ZOE-105", active: true },
  { truckId: "T-06", name: "Truck 6", plate: "ZOE-106", active: true },
  { truckId: "T-07", name: "Truck 7", plate: "ZOE-107", active: true },
  { truckId: "T-08", name: "Truck 8", plate: "ZOE-108", active: true },
];

function mockStop(seq: number, over: Partial<Stop>): Stop {
  return {
    stopId: `S-${seq}`,
    routeId: "R-MOCK",
    customerId: `C-${seq}`,
    sequence: seq,
    state: "Waiting",
    custName: "Customer",
    custPhone: "+15555550100",
    address: "123 Main St",
    ...over,
  };
}

/** A deterministic sample route for a given truck. */
export function mockRoute(truckId: string, date: string): Route {
  const routeId = `R-${date}-${truckId}`;
  const stops: Stop[] = [
    mockStop(1, {
      routeId,
      customerId: "C-1",
      custName: "Acme Events Co.",
      custPhone: "+15555550111",
      address: "1200 Oak St, Springfield",
      plannedWindow: "1:00p – 3:00p",
      eta: "2:45p",
    }),
    mockStop(2, {
      routeId,
      customerId: "C-2",
      custName: "Riverside Weddings",
      custPhone: "+15555550122",
      address: "88 Lakeview Dr, Springfield",
      plannedWindow: "3:00p – 5:00p",
      eta: "3:40p",
    }),
    mockStop(3, {
      routeId,
      customerId: "C-3",
      custName: "Grand Ballroom",
      custPhone: "+15555550133",
      address: "410 Center Ave, Springfield",
      plannedWindow: "5:00p – 7:00p",
      eta: "5:20p",
    }),
  ].map((s) => ({ ...s, routeId }));

  return {
    routeId,
    date,
    truckId,
    status: "ready",
    stops,
  };
}
