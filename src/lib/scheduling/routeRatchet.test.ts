import { describe, expect, it } from "vitest";
import { ratchetWindow, routeOwnWindow } from "./routeRatchet";
import type { Route } from "@/lib/types";

const DATE = "2026-12-10";
// A fixed day's hours as ISO (UTC is fine — the ratchet is pure time math).
const at = (h: number, m = 0) => `${DATE}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

describe("ratchetWindow (expand-only)", () => {
  const shift = { start: at(10), end: at(14), windowKnown: true };

  it("expands the end when the route runs later", () => {
    const r = ratchetWindow(shift, { start: at(10), end: at(16), known: true });
    expect(r.changed).toBe(true);
    expect(r.start).toBe(at(10));
    expect(r.end).toBe(at(16));
    expect(r.reason).toMatch(/later/);
  });

  it("expands the start when the route starts earlier", () => {
    const r = ratchetWindow(shift, { start: at(8), end: at(14), known: true });
    expect(r.changed).toBe(true);
    expect(r.start).toBe(at(8));
    expect(r.end).toBe(at(14));
    expect(r.reason).toMatch(/earlier/);
  });

  it("HOLDS (never shrinks) when the route got shorter", () => {
    const r = ratchetWindow(shift, { start: at(11), end: at(13), known: true });
    expect(r.changed).toBe(false);
    expect(r.start).toBe(at(10)); // unchanged
    expect(r.end).toBe(at(14)); // unchanged
  });

  it("holds when the route window equals the shift", () => {
    expect(ratchetWindow(shift, { start: at(10), end: at(14), known: true }).changed).toBe(false);
  });

  it("adopts the route window when the shift has no window yet", () => {
    const r = ratchetWindow({ start: null, end: null, windowKnown: false }, { start: at(9), end: at(15), known: true });
    expect(r.changed).toBe(true);
    expect(r.start).toBe(at(9));
    expect(r.end).toBe(at(15));
    expect(r.windowKnown).toBe(true);
  });

  it("holds when the route window is unknown/invalid", () => {
    expect(ratchetWindow(shift, { start: null, end: null, known: false }).changed).toBe(false);
    expect(ratchetWindow(shift, { start: at(16), end: at(14), known: true }).changed).toBe(false); // end<=start
  });

  it("grows both ends when the route is wider on both sides", () => {
    const r = ratchetWindow(shift, { start: at(9), end: at(17), known: true });
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
