import { describe, expect, it } from "vitest";
import {
  advanceNextStop,
  getRoute,
  insertEventIfNew,
  writeRoute,
} from "./repo";
import type { Route } from "@/lib/types";

// DATABASE_PATH is ":memory:" (see vitest.config.ts), so this hits a throwaway DB.

function sampleRoute(truckId = "NPR-1"): Route {
  const routeId = `R-2026-08-30-${truckId}`;
  return {
    routeId,
    date: "2026-08-30",
    truckId,
    status: "ready",
    stops: [
      {
        stopId: `${routeId}-S1`,
        routeId,
        customerId: "C1",
        sequence: 1,
        state: "Waiting",
        custName: "Acme Events Co.",
        custPhone: "+15555550111",
        address: "1200 Oak St",
      },
      {
        stopId: `${routeId}-S2`,
        routeId,
        customerId: "C2",
        sequence: 2,
        state: "Waiting",
        custName: "Riverside Weddings",
        custPhone: "+15555550122",
        address: "88 Lakeview Dr",
        dayOfName: "Jordan",
        dayOfPhone: "+15555550190",
      },
    ],
  };
}

describe("writeRoute / getRoute", () => {
  it("round-trips a route with its stops, including the day-of coordinator", () => {
    writeRoute(sampleRoute());
    const got = getRoute("NPR-1");
    expect(got?.stops).toHaveLength(2);
    expect(got?.stops[0].custName).toBe("Acme Events Co.");
    expect(got?.stops[1].dayOfName).toBe("Jordan");
    expect(got?.stops[1].dayOfPhone).toBe("+15555550190");
    expect(got?.stops[0].dayOfName).toBeUndefined();
  });

  it("replaces stops on re-write instead of duplicating them", () => {
    writeRoute(sampleRoute("NPR-2"));
    writeRoute(sampleRoute("NPR-2")); // same route again
    expect(getRoute("NPR-2")?.stops).toHaveLength(2);
  });

  it("keeps stop ids unique across two trucks (no global-PK collision)", () => {
    writeRoute(sampleRoute("NPR-1"));
    // A different truck's route must not throw on its own S1/S2 ids.
    expect(() => writeRoute(sampleRoute("E450"))).not.toThrow();
    expect(getRoute("E450")?.stops).toHaveLength(2);
  });
});

describe("insertEventIfNew", () => {
  it("dedupes on the idempotency key (double-tap / offline replay)", () => {
    const e = {
      eventId: "E1",
      idempotencyKey: "idem-123",
      action: "ARRIVED",
      ts: "2026-08-30T12:00:00Z",
    };
    expect(insertEventIfNew(e)).toBe(true);
    expect(insertEventIfNew({ ...e, eventId: "E2" })).toBe(false);
  });
});

describe("advanceNextStop", () => {
  it("moves the next stop by sequence into EnRoute and returns it", () => {
    writeRoute(sampleRoute("NPR-1"));
    const routeId = "R-2026-08-30-NPR-1";
    const next = advanceNextStop(routeId, 1);
    expect(next?.sequence).toBe(2);
    expect(next?.state).toBe("EnRoute");
    expect(next?.dayOfName).toBe("Jordan");
    // Nothing after the last stop.
    expect(advanceNextStop(routeId, 2)).toBeNull();
  });
});
