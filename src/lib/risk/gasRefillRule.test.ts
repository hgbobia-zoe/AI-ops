import { describe, expect, it } from "vitest";
import type { Route, Stop } from "@/lib/types";
import { gasRefillFindings } from "./gasRefillRule";
import { DEFAULT_GAS_REFILL, gasStopId, gasTaskDedupeKey } from "@/lib/dispatch/gasRefill";

const R = "R-2031-01-06-NPR-1-7";
const s = (p: Partial<Stop> & { sequence: number }): Stop => ({ stopId: `${R}-S${p.sequence}`, routeId: R, customerId: "c", state: "Waiting", custName: "Jones Wedding", custPhone: "", address: "x", ...p });
const route = (stops: Stop[], p: Partial<Route> = {}): Route => ({ routeId: R, date: "2031-01-06", truckId: "NPR-1", status: "ready", stops, ...p });
const heaterPickup = s({ sequence: 1, kind: "pickup", txId: "T1", items: [{ name: "Tent Heater", quantity: 2 }] });
const K = DEFAULT_GAS_REFILL.keywords;

describe("route checker: a gas tank pickup needs the refill stop or the next-day task", () => {
  it("flags a heater pickup with neither, as HIGH, naming what triggered it", () => {
    const f = gasRefillFindings([route([heaterPickup])], K, () => false, () => "Isuzu NPR 1");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ signature: `gas_refill_missing|${R}`, riskType: "gas_refill_missing", category: "PICKUP", severity: "HIGH", routeId: R, eventId: "T1", affectedEntity: "Tent Heater x2", actionTarget: "dispatch" });
    expect(f[0].description).toContain("Isuzu NPR 1 picks up gas tanks (Tent Heater x2) from Jones Wedding");
  });

  it("is satisfied by the refill stop", () => {
    expect(gasRefillFindings([route([heaterPickup, s({ sequence: 2, stopId: gasStopId(R) })])], K, () => false)).toEqual([]);
  });

  it("is satisfied by the next-day task (after hours)", () => {
    expect(gasRefillFindings([route([heaterPickup])], K, (key) => key === gasTaskDedupeKey(R))).toEqual([]);
  });

  it("ignores deliveries, routes without tanks, and routes already closed out", () => {
    expect(gasRefillFindings([route([{ ...heaterPickup, kind: "delivery" }])], K, () => false)).toEqual([]);
    expect(gasRefillFindings([route([{ ...heaterPickup, items: [{ name: "Chair" }] }])], K, () => false)).toEqual([]);
    expect(gasRefillFindings([route([heaterPickup], { status: "done" })], K, () => false)).toEqual([]);
  });
});
