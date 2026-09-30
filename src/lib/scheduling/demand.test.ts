import { describe, it, expect } from "vitest";
import { buildDemand } from "./demand";
import type { Route, Stop } from "@/lib/types";

// Minimal stop builder — only the fields the demand generator reads.
function stop(partial: Partial<Stop>): Stop {
  return {
    stopId: partial.stopId ?? "s1",
    routeId: partial.routeId ?? "R1",
    customerId: partial.customerId ?? "c1",
    sequence: partial.sequence ?? 1,
    state: partial.state ?? "Waiting",
    custName: partial.custName ?? "Test Customer",
    custPhone: partial.custPhone ?? "",
    address: partial.address ?? "",
    kind: partial.kind ?? "delivery",
    plannedWindow: partial.plannedWindow,
    eta: partial.eta,
    items: partial.items,
  };
}

function route(partial: Partial<Route>): Route {
  return {
    routeId: partial.routeId ?? "R1",
    date: partial.date ?? "2026-10-03",
    truckId: partial.truckId ?? "NPR-1",
    status: partial.status ?? "ready",
    stops: partial.stops ?? [stop({})],
  };
}

describe("buildDemand", () => {
  it("emits one driver shift per active route, spanning its window", () => {
    const r = route({
      stops: [
        stop({ sequence: 1, plannedWindow: "2026-10-03T14:00:00.000Z" }),
        stop({ sequence: 2, plannedWindow: "2026-10-03T16:00:00.000Z" }),
      ],
    });
    const demand = buildDemand([r]);
    const drivers = demand.filter((d) => d.role === "driver");
    expect(drivers).toHaveLength(1);
    expect(drivers[0].headcount).toBe(1);
    expect(drivers[0].windowKnown).toBe(true);
    expect(drivers[0].routeId).toBe("R1");
    // window includes the load/return buffers, so start < first stop and end > last stop
    expect(new Date(drivers[0].startTime!).getTime()).toBeLessThan(Date.parse("2026-10-03T14:00:00.000Z"));
    expect(new Date(drivers[0].endTime!).getTime()).toBeGreaterThan(Date.parse("2026-10-03T16:00:00.000Z"));
  });

  it("adds field crew when a tent is on the route (crewForRoute − 1)", () => {
    const r = route({
      stops: [stop({ plannedWindow: "2026-10-03T14:00:00.000Z", items: [{ name: "20x20 Frame Tent" }] })],
    });
    const demand = buildDemand([r]);
    const field = demand.filter((d) => d.role === "field");
    expect(field).toHaveLength(1);
    expect(field[0].headcount).toBe(1); // tent → 2 crew total, minus the driver = 1 field
    expect(field[0].reasons.join(" ")).toMatch(/tent/i);
  });

  it("gives a big tent more field crew", () => {
    const r = route({
      stops: [stop({ plannedWindow: "2026-10-03T14:00:00.000Z", items: [{ name: "40x60 Sailcloth Tent" }] })],
    });
    const field = buildDemand([r]).filter((d) => d.role === "field");
    expect(field[0].headcount).toBe(2); // big tent → 3 crew total, minus driver = 2
  });

  it("no field shift when there's no tent", () => {
    const r = route({
      stops: [stop({ plannedWindow: "2026-10-03T14:00:00.000Z", items: [{ name: "100 Chiavari Chairs" }] })],
    });
    expect(buildDemand([r]).some((d) => d.role === "field")).toBe(false);
  });

  it("emits one prep shift the day BEFORE, sized by delivery-route count", () => {
    // 4 delivery routes → ceil(4/3) = 2 prep crew
    const routes = [1, 2, 3, 4].map((i) =>
      route({ routeId: `R${i}`, truckId: `T${i}`, stops: [stop({ routeId: `R${i}`, kind: "delivery", plannedWindow: "2026-10-03T14:00:00.000Z" })] }),
    );
    const demand = buildDemand(routes);
    const prep = demand.filter((d) => d.role === "prep");
    expect(prep).toHaveLength(1);
    expect(prep[0].date).toBe("2026-10-02"); // day before
    expect(prep[0].headcount).toBe(2);
    expect(prep[0].windowKnown).toBe(false); // prep clock time is unknown, not fabricated
    expect(prep[0].startTime).toBeNull();
  });

  it("pickup-only days need no prep crew", () => {
    const r = route({ stops: [stop({ kind: "pickup", plannedWindow: "2026-10-03T14:00:00.000Z" })] });
    expect(buildDemand([r]).some((d) => d.role === "prep")).toBe(false);
  });

  it("marks the window unknown (never fabricated) when a route has no stop times", () => {
    const r = route({ stops: [stop({ plannedWindow: undefined, eta: undefined })] });
    const drivers = buildDemand([r]).filter((d) => d.role === "driver");
    expect(drivers).toHaveLength(1);
    expect(drivers[0].windowKnown).toBe(false);
    expect(drivers[0].startTime).toBeNull();
  });

  it("skips done routes and empty routes", () => {
    expect(buildDemand([route({ status: "done" })])).toHaveLength(0);
    expect(buildDemand([route({ stops: [] })])).toHaveLength(0);
  });
});
