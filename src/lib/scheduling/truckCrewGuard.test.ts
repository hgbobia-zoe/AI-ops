import { describe, it, expect } from "vitest";
import { findSeatViolations, isRouteSeat, knownNotTruckCrew } from "./truckCrewGuard";
import type { CrewRole } from "@/lib/connecteam";

type S = Parameters<typeof findSeatViolations>[0][number];
const shift = (over: Partial<S> = {}): S => ({
  id: "s1",
  date: "2026-11-02",
  routeId: "r1",
  truckId: "isuzu-1",
  role: "field",
  status: "scheduled" as S["status"],
  assignees: [],
  ...over,
});

const ROLES: Record<number, CrewRole> = { 1: "driver", 2: "warehouse", 3: "prep", 4: "other" };
const roleOf = (uid: number): CrewRole | null => ROLES[uid] ?? null;

describe("knownNotTruckCrew", () => {
  it("asset prep and office are not truck crew", () => {
    expect(knownNotTruckCrew("prep")).toBe(true);
    expect(knownNotTruckCrew("other")).toBe(true);
  });
  it("drivers and Warehouse Associates are truck crew", () => {
    expect(knownNotTruckCrew("driver")).toBe(false);
    expect(knownNotTruckCrew("warehouse")).toBe(false);
  });
  it("an unknown role never counts", () => {
    expect(knownNotTruckCrew(null)).toBe(false);
    expect(knownNotTruckCrew(undefined)).toBe(false);
  });
});

describe("isRouteSeat", () => {
  it("driver and field shifts on a route are route seats", () => {
    expect(isRouteSeat(shift({ role: "driver" }))).toBe(true);
    expect(isRouteSeat(shift({ role: "field" }))).toBe(true);
  });
  it("prep shifts, shifts with no route, and cancelled shifts are not", () => {
    expect(isRouteSeat(shift({ role: "prep" }))).toBe(false);
    expect(isRouteSeat(shift({ routeId: null }))).toBe(false);
    expect(isRouteSeat(shift({ status: "cancelled" as S["status"] }))).toBe(false);
  });
});

describe("findSeatViolations", () => {
  it("flags an Event Asset Processor on a route helper seat (the Raquel case)", () => {
    const v = findSeatViolations([shift({ assignees: [3] })], roleOf);
    expect(v).toEqual([{ shiftId: "s1", date: "2026-11-02", truckId: "isuzu-1", seat: "field", userId: 3, role: "prep" }]);
  });
  it("flags office staff on a driver seat", () => {
    expect(findSeatViolations([shift({ role: "driver", assignees: [4] })], roleOf)).toHaveLength(1);
  });
  it("leaves drivers and Warehouse Associates alone", () => {
    expect(findSeatViolations([shift({ role: "driver", assignees: [1] }), shift({ id: "s2", assignees: [2] })], roleOf)).toEqual([]);
  });
  it("never flags a worker whose role is unknown", () => {
    expect(findSeatViolations([shift({ assignees: [99] })], roleOf)).toEqual([]);
  });
  it("asset prep on a warehouse prep shift is fine", () => {
    expect(findSeatViolations([shift({ role: "prep", routeId: null, assignees: [3] })], roleOf)).toEqual([]);
  });
  it("only the asset prep person is flagged on a mixed seat", () => {
    const v = findSeatViolations([shift({ assignees: [2, 3] })], roleOf);
    expect(v.map((x) => x.userId)).toEqual([3]);
  });
});
