import { describe, expect, it } from "vitest";
import type { Stop } from "@/lib/types";
import {
  DEFAULT_GAS_REFILL,
  closeLabel,
  coerceGasRefill,
  gasStopId,
  gasTriggers,
  isRefillStop,
  planGasRefill,
  triggerSummary,
} from "./gasRefill";

// Jan 6 2031 is EST (UTC-5): 8:00 PM ET = 01:00Z the next day.
const D = "2031-01-06";
const et = (hm: string): string => `${D}T${hm}:00.000-05:00`;
const R = "R-2031-01-06-NPR-1-7";

function stop(p: Partial<Stop> & { sequence: number }): Stop {
  return { stopId: `${R}-S${p.sequence}`, routeId: R, customerId: "c", state: "Waiting", custName: "Smith", custPhone: "+13015550100", address: "1 Main St, Bethesda, MD", ...p };
}
const heaterPickup = (hm: string, extra: Partial<Stop> = {}): Stop =>
  stop({ sequence: 2, kind: "pickup", plannedWindow: et(hm), plannedOnSiteMin: 45, txId: "T1", custName: "Jones Wedding", items: [{ name: "Patio Heater", quantity: 3 }, { name: "Tent Heater" }, { name: "Round Table", quantity: 10 }], ...extra });
const delivery = stop({ sequence: 1, kind: "delivery", plannedWindow: et("09:00"), items: [{ name: "Patio Heater", quantity: 2 }] });

describe("which pickups bring a gas tank back", () => {
  it("pickup heater lines only (deliveries never need a refill), with quantities", () => {
    const t = gasTriggers([delivery, heaterPickup("14:00")], DEFAULT_GAS_REFILL.keywords);
    expect(t).toEqual([{ stopId: `${R}-S2`, custName: "Jones Wedding", txId: "T1", items: [{ name: "Patio Heater", quantity: 3 }, { name: "Tent Heater", quantity: 1 }] }]);
    expect(triggerSummary(t)).toBe("Patio Heater x3, Tent Heater");
  });

  it("propane tank lines count too; nothing matching means nothing to do", () => {
    expect(gasTriggers([stop({ sequence: 1, kind: "pickup", items: [{ name: "20 lb Propane Tank" }] })], DEFAULT_GAS_REFILL.keywords)).toHaveLength(1);
    expect(gasTriggers([stop({ sequence: 1, kind: "pickup", items: [{ name: "Chiavari Chair" }] })], DEFAULT_GAS_REFILL.keywords)).toHaveLength(0);
  });
});

describe("the refill stop: last stop before the warehouse, only if it beats closing", () => {
  it("adds it after the last stop with the projected arrival (leave 2:45 PM + 25 min drive = 3:10 PM)", () => {
    const r = planGasRefill({ routeId: R, date: D, stops: [delivery, heaterPickup("14:00")], settings: DEFAULT_GAS_REFILL, driveMin: 25 });
    expect(r.plan).toMatchObject({ kind: "stop", driveAssumed: false });
    const gas = r.stops[r.stops.length - 1];
    expect(gas).toMatchObject({ stopId: gasStopId(R), sequence: 3, state: "Waiting", custPhone: "", address: DEFAULT_GAS_REFILL.address, custName: "Gas refill: Patio Heater x3, Tent Heater", plannedWindow: new Date(et("15:10")).toISOString(), plannedTransitMin: 25 });
    expect(gas.items).toBeUndefined(); // never counted as a customer's gear
    expect(gas.txId).toBeUndefined(); // never synced to a Goodshuffle project
  });

  it("arriving at 8:00 PM or later means no stop, a next-day task instead", () => {
    // Leave 7:15 PM + 45 min = 8:00 PM exactly: closed.
    const r = planGasRefill({ routeId: R, date: D, stops: [heaterPickup("18:30")], settings: DEFAULT_GAS_REFILL, driveMin: 45 });
    expect(r.plan).toEqual({ kind: "task", arrivalMs: Date.parse(et("20:00")), driveAssumed: false });
    expect(r.stops.some(isRefillStop)).toBe(false);
    // One minute earlier makes it.
    expect(planGasRefill({ routeId: R, date: D, stops: [heaterPickup("18:30")], settings: DEFAULT_GAS_REFILL, driveMin: 44 }).plan.kind).toBe("stop");
  });

  it("no drive time: assumes 30 minutes and says so", () => {
    const r = planGasRefill({ routeId: R, date: D, stops: [heaterPickup("14:00")], settings: DEFAULT_GAS_REFILL, driveMin: null });
    expect(r.plan).toMatchObject({ kind: "stop", driveAssumed: true, arrivalMs: Date.parse(et("15:15")) });
  });

  it("re-planning is idempotent: one refill stop, same id, never a duplicate", () => {
    const first = planGasRefill({ routeId: R, date: D, stops: [delivery, heaterPickup("14:00")], settings: DEFAULT_GAS_REFILL, driveMin: 25 }).stops;
    const again = planGasRefill({ routeId: R, date: D, stops: first, settings: DEFAULT_GAS_REFILL, driveMin: 25 }).stops;
    expect(again.filter(isRefillStop)).toHaveLength(1);
    expect(again).toEqual(first);
  });

  it("a refill stop the driver already acted on is kept as it is, whatever else changed", () => {
    const placed = planGasRefill({ routeId: R, date: D, stops: [heaterPickup("14:00")], settings: DEFAULT_GAS_REFILL, driveMin: 25 }).stops;
    const done = placed.map((s) => (isRefillStop(s) ? { ...s, state: "Completed" as const, completedAt: "2031-01-06T20:20:00Z" } : s));
    // Goodshuffle moved the pickup late (would be after closing) and dropped the heaters: still kept.
    const later = done.map((s) => (s.kind === "pickup" ? { ...s, plannedWindow: et("19:30"), items: [] } : s));
    const r = planGasRefill({ routeId: R, date: D, stops: later, settings: DEFAULT_GAS_REFILL, driveMin: 25 });
    expect(r.stops.find(isRefillStop)).toMatchObject({ state: "Completed", completedAt: "2031-01-06T20:20:00Z" });
  });

  it("a waiting refill stop goes away when the heaters come off the route", () => {
    const placed = planGasRefill({ routeId: R, date: D, stops: [heaterPickup("14:00")], settings: DEFAULT_GAS_REFILL, driveMin: 25 }).stops;
    const noHeaters = placed.map((s) => (s.kind === "pickup" ? { ...s, items: [{ name: "Round Table" }] } : s));
    expect(planGasRefill({ routeId: R, date: D, stops: noHeaters, settings: DEFAULT_GAS_REFILL, driveMin: 25 }).stops.some(isRefillStop)).toBe(false);
  });
});

describe("the admin setting", () => {
  it("labels the closing time and keeps the current value for a bad save", () => {
    expect(closeLabel("20:00")).toBe("8:00 PM");
    expect(closeLabel("09:30")).toBe("9:30 AM");
    expect(coerceGasRefill({ address: "  ", closeTime: "25:00", keywords: [" Patio Heater ", "patio heater", ""] }, DEFAULT_GAS_REFILL)).toEqual({ ...DEFAULT_GAS_REFILL, keywords: ["patio heater"] });
    expect(coerceGasRefill({ closeTime: "7:45" }, DEFAULT_GAS_REFILL).closeTime).toBe("07:45");
    expect(coerceGasRefill(null, DEFAULT_GAS_REFILL)).toBe(DEFAULT_GAS_REFILL);
  });
});
