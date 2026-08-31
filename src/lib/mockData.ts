// In-memory mock route data for M1 (before Goodshuffle ingestion exists).
// Served by /api/route when USE_MOCK_DATA is on. This lets the full tablet flow
// be exercised end-to-end without any backend wired up.

import type { Route, Stop, Vehicle } from "./types";

// Truck designations are provisional — will be renamed later.
export const MOCK_VEHICLES: Vehicle[] = [
  { truckId: "NPR-1", name: "Isuzu NPR 1", active: true },
  { truckId: "NPR-2", name: "Isuzu NPR 2", active: true },
  { truckId: "E450", name: "Ford E450", active: true },
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
      // This event has a day-of coordinator — texts go to them too.
      dayOfName: "Jordan (Coordinator)",
      dayOfPhone: "+15555550190",
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
    // stop_id is a global primary key, so it must be unique across ALL routes —
    // scope it to the routeId (not just the sequence) or a second truck's mock
    // route collides with the first's S-1/S-2/S-3.
  ].map((s) => ({ ...s, routeId, stopId: `${routeId}-S${s.sequence}` }));

  return {
    routeId,
    date,
    truckId,
    status: "ready",
    stops,
  };
}
