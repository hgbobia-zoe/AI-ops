import { describe, it, expect } from "vitest";
import { assessDay, daysUntil } from "./engine";
import type { EngineRoute, EngineShift, RiskFinding, RiskSeverity } from "./types";

// All fixtures live on a single event day; "now" is 5 days before (no proximity escalation
// unless a scenario overrides it).
const DATE = "2026-09-10";
const NOW = new Date("2026-09-05T12:00:00Z"); // daysUntil(DATE) === 5

const iso = (h: number, m = 0) => `${DATE}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`;
const unix = (h: number, m = 0) => Math.floor(Date.parse(iso(h, m)) / 1000);

function shift(userId: number, name: string, startH: number, endH: number): EngineShift {
  return { userId, name, startUnix: unix(startH), endUnix: unix(endH), isOpen: false };
}
function route(
  routeId: string,
  truckId: string,
  opts: { driverId?: string; driverName?: string; stopHour?: number; venue?: string; items?: { name: string; quantity?: number }[] } = {},
): EngineRoute {
  const hour = opts.stopHour ?? 9;
  return {
    routeId,
    truckId,
    date: DATE,
    status: "ready",
    driverId: opts.driverId,
    driverName: opts.driverName,
    stops: [{ sequence: 1, custName: opts.venue ?? "Venue X", kind: "delivery", plannedWindow: iso(hour), items: opts.items }],
  };
}
const has = (f: RiskFinding[], type: string, sev?: RiskSeverity) =>
  f.some((x) => x.riskType === type && (sev ? x.severity === sev : true));
const maxSev = (f: RiskFinding[]): RiskSeverity | null => {
  const order: RiskSeverity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  return f.reduce<RiskSeverity | null>((m, x) => (m === null || order.indexOf(x.severity) > order.indexOf(m) ? x.severity : m), null);
};

// Fully-staffed knobs so unrelated rules stay quiet and each test isolates one thing.
const enabled = { driverAssignmentEnabled: true } as const;
const warehouseOk: EngineShift[] = [shift(90, "Whse A", 6, 12)];

describe("Event Risk engine — 12 scenarios", () => {
  it("S1: one route → one driver → covering shift → PASS", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { driverId: "1", driverName: "Al", stopHour: 9 })],
      driverShifts: [shift(1, "Al", 7, 18)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      now: NOW,
      config: enabled,
    });
    expect(f).toEqual([]);
  });

  it("S2: two routes → two drivers → same venue/time → PASS (no conflict)", () => {
    const f = assessDay({
      date: DATE,
      routes: [
        route("R1", "NPR-1", { driverId: "1", driverName: "Al", venue: "Venue X" }),
        route("R2", "E450", { driverId: "2", driverName: "Bo", venue: "Venue X" }),
      ],
      driverShifts: [shift(1, "Al", 7, 18), shift(2, "Bo", 7, 18)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 2,
      now: NOW,
      config: enabled,
    });
    expect(f).toEqual([]);
  });

  it("S3: two routes → one driver → CRITICAL", () => {
    const f = assessDay({
      date: DATE,
      routes: [
        route("R1", "NPR-1", { driverId: "1", driverName: "Al" }),
        route("R2", "E450", { driverId: "1", driverName: "Al" }),
      ],
      driverShifts: [shift(1, "Al", 7, 18)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 2,
      now: NOW,
      config: enabled,
    });
    expect(has(f, "driver_double_booked", "CRITICAL")).toBe(true);
  });

  it("S4: driver assigned but shift doesn't cover the route → HIGH", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { driverId: "1", driverName: "Al", stopHour: 9 })],
      driverShifts: [shift(1, "Al", 7, 8)], // ends 8:00, route window runs to ~10:00
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      now: NOW,
      config: enabled,
    });
    expect(has(f, "driver_shift_gap", "HIGH")).toBe(true);
    expect(maxSev(f)).toBe("HIGH");
  });

  it("S5: one route → no driver → CRITICAL", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { stopHour: 9 })], // no driverId
      driverShifts: [],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      now: NOW,
      config: enabled,
    });
    expect(has(f, "route_no_driver", "CRITICAL")).toBe(true);
  });

  it("S6: two different routes → same venue → different drivers → PASS", () => {
    const f = assessDay({
      date: DATE,
      routes: [
        route("R1", "NPR-1", { driverId: "1", driverName: "Al", venue: "Venue X", stopHour: 8 }),
        route("R2", "E450", { driverId: "2", driverName: "Bo", venue: "Venue X", stopHour: 8 }),
      ],
      driverShifts: [shift(1, "Al", 6, 18), shift(2, "Bo", 6, 18)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 2,
      now: NOW,
      config: enabled,
    });
    expect(f).toEqual([]);
  });

  it("S7: one driver → overlapping routes → CRITICAL", () => {
    const f = assessDay({
      date: DATE,
      routes: [
        route("R1", "NPR-1", { driverId: "7", driverName: "Cy", stopHour: 9 }),
        route("R2", "E450", { driverId: "7", driverName: "Cy", stopHour: 10 }),
      ],
      driverShifts: [shift(7, "Cy", 6, 20)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 2,
      now: NOW,
      config: enabled,
    });
    expect(has(f, "driver_double_booked", "CRITICAL")).toBe(true);
  });

  it("S8: warehouse staffing insufficient → HIGH (escalates as event nears)", () => {
    const args = {
      date: DATE,
      routes: [route("R1", "NPR-1", { driverId: "1", driverName: "Al" }), route("R2", "E450", { driverId: "2", driverName: "Bo" }), route("R3", "NPR-2", { driverId: "3", driverName: "Di" })],
      driverShifts: [shift(1, "Al", 7, 18), shift(2, "Bo", 7, 18), shift(3, "Di", 7, 18)],
      warehouseShifts: [] as EngineShift[], // none scheduled
      fieldCrewScheduled: 3,
      config: enabled,
    };
    const far = assessDay({ ...args, now: NOW }); // 5 days out
    expect(has(far, "warehouse_shortage", "HIGH")).toBe(true);
    const dayBefore = assessDay({ ...args, now: new Date("2026-09-09T12:00:00Z") }); // 1 day out
    expect(has(dayBefore, "warehouse_shortage", "CRITICAL")).toBe(true);
  });

  it("S9: tent installation crew shortage → staffing risk", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "E450", { driverId: "1", driverName: "Al", items: [{ name: "40x60 Sailcloth Tent", quantity: 1 }] })],
      driverShifts: [shift(1, "Al", 7, 18)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1, // a 40x60 tent needs 3 crew
      now: NOW,
      config: enabled,
    });
    expect(has(f, "setup_crew_shortage")).toBe(true);
  });

  it("S10: same problem on a re-run → identical signatures (dedup-ready)", () => {
    const args = {
      date: DATE,
      routes: [route("R1", "NPR-1", { stopHour: 9 })],
      driverShifts: [] as EngineShift[],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      now: NOW,
      config: enabled,
    };
    const a = assessDay(args).map((x) => x.signature).sort();
    const b = assessDay(args).map((x) => x.signature).sort();
    expect(a).toEqual(b);
    expect(a).toContain("route_no_driver|R1");
  });

  it("S11: fixing the condition removes the finding (resolution-ready)", () => {
    const broken = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { stopHour: 9 })],
      driverShifts: [],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      now: NOW,
      config: enabled,
    });
    expect(has(broken, "route_no_driver")).toBe(true);
    const fixed = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { driverId: "1", driverName: "Al", stopHour: 9 })],
      driverShifts: [shift(1, "Al", 7, 18)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      now: NOW,
      config: enabled,
    });
    expect(has(fixed, "route_no_driver")).toBe(false);
  });

  it("S12: severity escalates as the event approaches", () => {
    const args = {
      date: DATE,
      routes: [route("R1", "NPR-1", { driverId: "1", driverName: "Al" })],
      driverShifts: [] as EngineShift[], // assigned driver has no shift → driver_not_scheduled (HIGH base)
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      config: enabled,
    };
    const far = assessDay({ ...args, now: NOW }); // 5 days → HIGH
    const near = assessDay({ ...args, now: new Date("2026-09-09T12:00:00Z") }); // 1 day → CRITICAL
    expect(has(far, "driver_not_scheduled", "HIGH")).toBe(true);
    expect(has(near, "driver_not_scheduled", "CRITICAL")).toBe(true);
  });

  it("daysUntil computes calendar-day distance", () => {
    expect(daysUntil("2026-09-10", new Date("2026-09-05T12:00:00Z"))).toBe(5);
    expect(daysUntil("2026-09-10", new Date("2026-09-10T00:00:00Z"))).toBe(0);
  });
});

describe("Event Risk engine — hardening edge cases", () => {
  it("unverified staffing → UNVERIFIED (MEDIUM), never a false CRITICAL/shortage", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { driverId: "1", driverName: "Al" })],
      driverShifts: [],
      warehouseShifts: [],
      fieldCrewScheduled: 0,
      staffingVerified: false,
      now: NOW,
      config: enabled,
    });
    expect(has(f, "staffing_unverified", "MEDIUM")).toBe(true);
    expect(f.some((x) => x.severity === "CRITICAL")).toBe(false);
    expect(has(f, "driver_shortage")).toBe(false);
    expect(has(f, "warehouse_shortage")).toBe(false);
    expect(has(f, "driver_not_scheduled")).toBe(false);
    expect(has(f, "setup_crew_shortage")).toBe(false);
  });

  it("unverified staffing STILL flags a route with no driver (a Dispatch fact)", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", {})],
      driverShifts: [],
      staffingVerified: false,
      now: NOW,
      config: enabled,
    });
    expect(has(f, "route_no_driver", "CRITICAL")).toBe(true);
  });

  it("shift exactly covering the full buffered window → PASS (no tight flag)", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { driverId: "1", driverName: "Al", stopHour: 9 })],
      driverShifts: [shift(1, "Al", 8, 10)], // window is 8:00–10:00 (±60m buffer around a 9:00 stop)
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      now: NOW,
      config: enabled,
    });
    expect(f).toEqual([]);
  });

  it("shift covers the stops but not the load/return buffer → MEDIUM tight (not HIGH gap)", () => {
    const r = {
      routeId: "R2",
      truckId: "E450",
      date: DATE,
      status: "ready",
      driverId: "2",
      driverName: "Bo",
      stops: [
        { sequence: 1, custName: "A", kind: "delivery" as const, plannedWindow: iso(9) },
        { sequence: 2, custName: "B", kind: "delivery" as const, plannedWindow: iso(15) },
      ],
    };
    const f = assessDay({
      date: DATE,
      routes: [r],
      driverShifts: [shift(2, "Bo", 9, 15)], // covers 9–15 stops but not the 8–16 buffered window
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      now: NOW,
      config: enabled,
    });
    expect(has(f, "driver_tight_buffer", "MEDIUM")).toBe(true);
    expect(has(f, "driver_shift_gap")).toBe(false);
  });

  it("same driver on two NON-overlapping routes → no double-booking", () => {
    const f = assessDay({
      date: DATE,
      routes: [
        route("R1", "NPR-1", { driverId: "9", driverName: "Cy", stopHour: 8 }),
        route("R2", "E450", { driverId: "9", driverName: "Cy", stopHour: 18 }),
      ],
      driverShifts: [shift(9, "Cy", 6, 22)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 2,
      now: NOW,
      config: enabled,
    });
    expect(has(f, "driver_double_booked")).toBe(false);
  });

  it("pickup day: unload uncovered → unload_shortage; covered → none; unknown → not guessed", () => {
    const pickup = {
      routeId: "R1",
      truckId: "NPR-1",
      date: DATE,
      status: "ready",
      driverId: "1",
      driverName: "Al",
      stops: [{ sequence: 1, custName: "X", kind: "pickup" as const, plannedWindow: iso(14) }],
    };
    const base = { date: DATE, routes: [pickup], driverShifts: [shift(1, "Al", 7, 20)], warehouseShifts: warehouseOk, fieldCrewScheduled: 1, now: NOW, config: enabled };
    expect(has(assessDay({ ...base, unloadCovered: false }), "unload_shortage")).toBe(true);
    expect(has(assessDay({ ...base, unloadCovered: true }), "unload_shortage")).toBe(false);
    expect(has(assessDay({ ...base }), "unload_shortage")).toBe(false); // undefined → never guessed
  });

  it("delivery-only day never flags unload, even if marked uncovered", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { driverId: "1", driverName: "Al" })],
      driverShifts: [shift(1, "Al", 7, 18)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      unloadCovered: false,
      now: NOW,
      config: enabled,
    });
    expect(has(f, "unload_shortage")).toBe(false);
  });

  it("route with no stop times → schedule unverified, not a coverage failure", () => {
    const r = {
      routeId: "R3",
      truckId: "NPR-1",
      date: DATE,
      status: "ready",
      driverId: "1",
      driverName: "Al",
      stops: [{ sequence: 1, custName: "A", kind: "delivery" as const }], // no plannedWindow/eta
    };
    const f = assessDay({
      date: DATE,
      routes: [r],
      driverShifts: [shift(1, "Al", 7, 18)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      now: NOW,
      config: enabled,
    });
    expect(has(f, "route_schedule_unverified")).toBe(true);
    expect(has(f, "driver_shift_gap")).toBe(false);
  });
});

// The PRODUCTION default is driverAssignmentEnabled=false. These lock in that path (previously
// only the flag-on path was tested) and the fix for the partial-adoption CRITICAL cliff.
describe("Event Risk engine — driver-assignment DEFAULT (flag off, prod behavior)", () => {
  it("no drivers assigned → NO route_no_driver (no false CRITICAL flood)", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { stopHour: 9 }), route("R2", "E450", { stopHour: 9 })],
      driverShifts: [],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 2,
      now: NOW,
    });
    expect(has(f, "route_no_driver")).toBe(false);
  });

  it("assigning ONE driver does NOT flag the other unassigned route (no adoption cliff)", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { driverId: "1", driverName: "Al", stopHour: 9 }), route("R2", "E450", { stopHour: 9 })],
      driverShifts: [shift(1, "Al", 7, 18)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 2,
      now: NOW,
    });
    expect(has(f, "route_no_driver")).toBe(false); // E450 unassigned, but not flagged with flag off
  });

  it("an ASSIGNED driver is still validated with the flag off (shift gap caught)", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { driverId: "1", driverName: "Al", stopHour: 9 })],
      driverShifts: [shift(1, "Al", 7, 8)], // doesn't cover the route
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      now: NOW,
    });
    expect(has(f, "driver_shift_gap", "HIGH")).toBe(true);
  });

  it("two NON-overlapping routes need only ONE driver (no false shortage)", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { stopHour: 8 }), route("R2", "E450", { stopHour: 16 })],
      driverShifts: [shift(1, "Al", 6, 20)], // one driver, whole day
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 2,
      now: NOW,
    });
    expect(has(f, "driver_shortage")).toBe(false);
  });

  it("two OVERLAPPING routes DO need two drivers (shortage with one)", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { stopHour: 9 }), route("R2", "E450", { stopHour: 9 })],
      driverShifts: [shift(1, "Al", 6, 20)],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 2,
      now: NOW,
    });
    expect(has(f, "driver_shortage")).toBe(true);
  });

  it("flag ON → an unassigned route IS flagged route_no_driver (deliberate rollout)", () => {
    const f = assessDay({
      date: DATE,
      routes: [route("R1", "NPR-1", { stopHour: 9 })],
      driverShifts: [],
      warehouseShifts: warehouseOk,
      fieldCrewScheduled: 1,
      now: NOW,
      config: enabled,
    });
    expect(has(f, "route_no_driver", "CRITICAL")).toBe(true);
  });
});
