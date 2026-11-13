import { describe, expect, it } from "vitest";
import { routeOwnWindow } from "./routeRatchet";
import type { Route } from "@/lib/types";

const DATE = "2026-12-10";
// A fixed day's hours as ISO (UTC is fine — the tracker is pure time math).
const at = (h: number, m = 0) => `${DATE}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

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
