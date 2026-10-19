import { describe, expect, it } from "vitest";
import { trackWindow, routeOwnWindow } from "./routeRatchet";
import type { Route } from "@/lib/types";

const DATE = "2026-12-10";
// A fixed day's hours as ISO (UTC is fine — the tracker is pure time math).
const at = (h: number, m = 0) => `${DATE}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

describe("trackWindow (follow the route; never auto-shrink hours)", () => {
  const shift = { start: at(10), end: at(14), windowKnown: true };

  it("grows the end when the route runs later from the same start", () => {
    const r = trackWindow(shift, { start: at(10), end: at(16), known: true });
    expect(r.changed).toBe(true);
    expect(r.start).toBe(at(10));
    expect(r.end).toBe(at(16));
    expect(r.reason).toMatch(/later/);
  });

  it("moves the start earlier when the route starts earlier (same hours)", () => {
    const r = trackWindow(shift, { start: at(8), end: at(14), known: true });
    expect(r.changed).toBe(true);
    expect(r.start).toBe(at(8));
    expect(r.end).toBe(at(14)); // 6h route covered, ≥ the shift's 4h
    expect(r.reason).toMatch(/earlier/);
  });

  it("MOVES the whole block later (keeps hours) when the route slid later", () => {
    // Route 13:00–17:00 (4h). The shift was 10:00–14:00 (4h) and no longer covers it → slide the block to
    // the route's new start, preserving the worker's 4 hours (NOT 10:00–17:00, which would over-pay).
    const r = trackWindow(shift, { start: at(13), end: at(17), known: true });
    expect(r.changed).toBe(true);
    expect(r.start).toBe(at(13));
    expect(r.end).toBe(at(17));
    expect(r.reason).toMatch(/moved later/);
  });

  it("keeps the worker's hours when a later route is also SHORTER", () => {
    // Route slid to 13:00–15:00 (2h). Shift is 4h → move to 13:00 but hold 4h (13:00–17:00), never shrink.
    const r = trackWindow(shift, { start: at(13), end: at(15), known: true });
    expect(r.changed).toBe(true);
    expect(r.start).toBe(at(13));
    expect(r.end).toBe(at(17)); // 4h preserved, not cut to the 2h route
  });

  it("HOLDS when the shift already brackets the route (never shrink, no churn)", () => {
    const r = trackWindow(shift, { start: at(11), end: at(13), known: true });
    expect(r.changed).toBe(false);
    expect(r.start).toBe(at(10)); // unchanged
    expect(r.end).toBe(at(14)); // unchanged
  });

  it("holds when the route window equals the shift", () => {
    expect(trackWindow(shift, { start: at(10), end: at(14), known: true }).changed).toBe(false);
  });

  it("adopts the route window when the shift has no window yet", () => {
    const r = trackWindow({ start: null, end: null, windowKnown: false }, { start: at(9), end: at(15), known: true });
    expect(r.changed).toBe(true);
    expect(r.start).toBe(at(9));
    expect(r.end).toBe(at(15));
    expect(r.windowKnown).toBe(true);
  });

  it("holds when the route window is unknown/invalid", () => {
    expect(trackWindow(shift, { start: null, end: null, known: false }).changed).toBe(false);
    expect(trackWindow(shift, { start: at(16), end: at(14), known: true }).changed).toBe(false); // end<=start
  });

  it("grows both ends when the route is wider on both sides", () => {
    const r = trackWindow(shift, { start: at(9), end: at(17), known: true });
    expect(r.start).toBe(at(9));
    expect(r.end).toBe(at(17));
    expect(r.reason).toMatch(/later/);
    expect(r.reason).toMatch(/earlier/);
  });
});

describe("routeOwnWindow", () => {
  const route = (stops: Route["stops"]): Route =>
    ({ routeId: "R1", date: DATE, truckId: "E450", status: "planned", stops } as unknown as Route);

  it("derives a known window from stops with planned windows", () => {
    const w = routeOwnWindow(route([
      { sequence: 1, custName: "A", kind: "delivery", plannedWindow: at(9) },
      { sequence: 2, custName: "B", kind: "delivery", plannedWindow: at(15) },
    ] as unknown as Route["stops"]));
    expect(w.known).toBe(true);
    expect(w.start).not.toBeNull();
    expect(w.end).not.toBeNull();
  });

  it("is unknown for a route with no stop times", () => {
    expect(routeOwnWindow(route([])).known).toBe(false);
  });
});
