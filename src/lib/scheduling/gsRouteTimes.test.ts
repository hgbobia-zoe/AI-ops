import { describe, expect, it } from "vitest";
import { writeRoute, getRouteById } from "@/lib/db/repo";
import { routeWindow } from "@/lib/risk/engine";
import { DEFAULT_RISK_CONFIG, type EngineRoute } from "@/lib/risk/types";
import { routeOwnWindow } from "./routeRatchet";
import { routeTimes } from "@/lib/gsRouteTimes";
import type { Route } from "@/lib/types";

// Lisa's report (2026-11-13): the Nov 19 Isuzu route runs 9:35 AM to 1:32 PM in Goodshuffle (warehouse out
// to warehouse back, one drop off at 10:10 with 165 minutes on site), so the shift should be 9:30 to 1:30.
// The old stop based window was 10:10 minus and plus an hour: 9:15 to 11:10.
const GS_START = "2026-11-19T09:35:00.000-05:00";
const GS_END = "2026-11-19T13:32:00.000-05:00";
const DROP = "2026-11-19T10:10:00.000-05:00";
const et = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "none";

function route(p: Partial<Route> = {}): Route {
  const routeId = p.routeId ?? "R-2026-11-19-NPR-1-68147";
  return {
    routeId, date: "2026-11-19", truckId: "NPR-1", status: "ready", gsRouteId: "68147",
    stops: [{ stopId: `${routeId}-S1`, routeId, customerId: "C1", sequence: 1, state: "Waiting", custName: "A", custPhone: "", address: "1 Main St", kind: "delivery", plannedWindow: DROP, eta: DROP }],
    ...p,
  };
}

describe("crew shifts follow the Goodshuffle route times", () => {
  it("the crew window is the Goodshuffle route start to end, both on the quarter hour (9:30 to 1:30)", () => {
    const w = routeOwnWindow(route({ gsStart: GS_START, gsEnd: GS_END }));
    expect([et(w.start), et(w.end)]).toEqual(["9:30 AM", "1:30 PM"]);
  });

  it("falls back to the stop times when Goodshuffle's route times are unknown", () => {
    const w = routeOwnWindow(route());
    expect([et(w.start), et(w.end)]).toEqual(["9:15 AM", "11:15 AM"]); // 10:10 minus and plus an hour, rounded
  });

  it("the engine window (risk, demand, overlap) uses the same Goodshuffle times, keeping the raw stop span", () => {
    const er: EngineRoute = { routeId: "R", truckId: "NPR-1", date: "2026-11-19", status: "ready", gsStart: GS_START, gsEnd: GS_END, stops: [{ sequence: 1, custName: "A", kind: "delivery", plannedWindow: DROP }] };
    const w = routeWindow(er, DEFAULT_RISK_CONFIG)!;
    expect(w.startUnix * 1000).toBe(Date.parse(GS_START));
    expect(w.endUnix * 1000).toBe(Date.parse(GS_END));
    expect(w.rawStart * 1000).toBe(Date.parse(DROP));
    // A route with Goodshuffle times but no stop times still has a known window.
    expect(routeWindow({ ...er, stops: [] }, DEFAULT_RISK_CONFIG)?.known).toBe(true);
  });

  it("ignores bad Goodshuffle times (end before start, or over a day)", () => {
    const er: EngineRoute = { routeId: "R", truckId: "T", date: "2026-11-19", status: "ready", gsStart: GS_END, gsEnd: GS_START, stops: [{ sequence: 1, custName: "A", plannedWindow: DROP }] };
    expect(routeWindow(er, DEFAULT_RISK_CONFIG)!.startUnix * 1000).toBe(Date.parse(DROP) - 3600_000);
  });
});

describe("import keeps the Goodshuffle route times", () => {
  it("routeTimes accepts a sane pair and drops anything else", () => {
    expect(routeTimes(GS_START, GS_END)).toEqual({ gsStart: "2026-11-19T14:35:00.000Z", gsEnd: "2026-11-19T18:32:00.000Z" });
    expect(routeTimes(GS_END, GS_START)).toEqual({});
    expect(routeTimes("nope", GS_END)).toEqual({});
    expect(routeTimes(undefined, undefined)).toEqual({});
    expect(routeTimes(GS_START, "2026-11-21T09:35:00.000-05:00")).toEqual({});
  });

  it("stores them, overwrites when Goodshuffle changes them, and keeps them on a pull that does not send them", () => {
    const id = "R-2026-11-19-NPR-1-90001";
    writeRoute(route({ routeId: id, ...routeTimes(GS_START, GS_END) }));
    expect(getRouteById(id)).toMatchObject({ gsStart: "2026-11-19T14:35:00.000Z", gsEnd: "2026-11-19T18:32:00.000Z" });
    writeRoute(route({ routeId: id, ...routeTimes(GS_START, "2026-11-19T14:00:00.000-05:00") }));
    expect(getRouteById(id)?.gsEnd).toBe("2026-11-19T19:00:00.000Z");
    writeRoute(route({ routeId: id })); // an older extension or the kiosk: no route times sent
    expect(getRouteById(id)?.gsEnd).toBe("2026-11-19T19:00:00.000Z");
  });
});
