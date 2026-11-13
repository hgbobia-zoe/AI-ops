import { describe, expect, it } from "vitest";
import type { StaffShift } from "./types";
import { connecteamOverride, overrideAfterEdit, routeMatchDecision, routeTimeAudit, type CrewWin } from "./routeMatch";
import { buildRouteOptions, routeNearest } from "./routeOptions";
import type { Route } from "@/lib/types";

// Nov 14 2026 is EST (UTC-5). Route crew window 7:45 AM to 5:00 PM = 12:45Z to 22:00Z.
const D = "2026-11-14";
const z = (hm: string): string => `${D}T${hm}:00.000Z`;
const CREW: CrewWin = { start: z("12:45"), end: z("22:00"), known: true };

function shift(p: Partial<StaffShift> = {}): StaffShift {
  return {
    id: "S1", date: D, role: "field", headcount: 1, startTime: z("12:45"), endTime: z("22:00"), windowKnown: true, location: null,
    routeId: "R1", truckId: "NPR-1", eventLabel: null, reasons: [], notes: null, source: "derived", status: "draft", assignees: [1],
    instaworkHeadcount: 0, payRate: null, connecteamShiftId: null, connecteamSchedulerId: null, connecteamPublishedAt: null,
    connecteamContentHash: null, connecteamSyncedAt: null, connecteamLastModified: null, syncStatus: null, syncNote: null,
    instaworkGigId: null, instaworkPostedAt: null, lifecycleState: null, supervisorUserId: null, reportLocation: null, reportTime: null,
    equipment: [], instructions: null, routeOverride: null, routeWindowStart: null, routeWindowEnd: null, createdAt: "", updatedAt: "", ...p,
  };
}
const OV = { by: "Lisa", at: "2026-11-12T15:00:00.000Z", source: "dispatch" as const, routeStart: z("12:45"), routeEnd: z("22:00") };

describe("routeMatchDecision: shifts match the route unless someone overrides it", () => {
  it("the default is the route: a shift on the route time matches", () => {
    expect(routeMatchDecision(shift(), CREW)).toEqual({ kind: "matches", rebaseline: true });
    expect(routeMatchDecision(shift({ routeWindowStart: z("12:45"), routeWindowEnd: z("22:00") }), CREW)).toEqual({ kind: "matches", rebaseline: false });
  });

  it("puts an unpublished shift that differs onto the route time", () => {
    expect(routeMatchDecision(shift({ startTime: z("12:40") }), CREW)).toEqual({ kind: "correct", start: z("12:45"), end: z("22:00") });
    expect(routeMatchDecision(shift({ windowKnown: false, startTime: null, endTime: null }), CREW)).toMatchObject({ kind: "correct" });
  });

  it("follows the route when Goodshuffle changed it (both ways, a shorter route too)", () => {
    const was = { routeWindowStart: z("12:45"), routeWindowEnd: z("22:00") };
    const shorter: CrewWin = { start: z("14:00"), end: z("19:00"), known: true };
    expect(routeMatchDecision(shift(was), shorter)).toEqual({ kind: "follow", start: z("14:00"), end: z("19:00"), reason: "the route now starts later and the route now ends earlier" });
    // A published shift follows a real route change too (pushed to Connecteam by the job).
    expect(routeMatchDecision(shift({ ...was, connecteamShiftId: "ct1" }), shorter)).toMatchObject({ kind: "follow" });
  });

  it("never moves an overridden shift", () => {
    const d = routeMatchDecision(shift({ startTime: z("13:00"), routeOverride: OV, routeWindowStart: z("10:00"), routeWindowEnd: z("15:00") }), CREW);
    expect(d).toEqual({ kind: "override", override: OV });
  });

  it("holds a published shift that differs for an old reason (nothing published moves silently)", () => {
    expect(routeMatchDecision(shift({ startTime: z("13:00"), connecteamShiftId: "ct1" }), CREW)).toEqual({ kind: "differs_published", start: z("12:45"), end: z("22:00"), rebaseline: true });
  });

  it("does not apply to office, cancelled, routeless shifts, or a route with no stop times", () => {
    expect(routeMatchDecision(shift({ role: "office" }), CREW).kind).toBe("not_route");
    expect(routeMatchDecision(shift({ status: "cancelled" }), CREW).kind).toBe("not_route");
    expect(routeMatchDecision(shift({ routeId: null }), CREW).kind).toBe("not_route");
    expect(routeMatchDecision(shift(), { start: null, end: null, known: false }).kind).toBe("not_route");
  });
});

describe("overrides are explicit and stick", () => {
  it("a time change in the Dispatch editor records who, when, and the route time it replaced", () => {
    const ov = overrideAfterEdit(shift(), { startTime: z("13:00"), endTime: z("22:00") }, CREW, "Lisa", "2026-11-12T15:00:00.000Z");
    expect(ov).toEqual({ routeOverride: OV, routeWindowStart: z("12:45"), routeWindowEnd: z("22:00") });
  });

  it("setting it back to the route time clears the override (Reset to route by hand)", () => {
    const ov = overrideAfterEdit(shift({ startTime: z("13:00") }), { startTime: z("12:45"), endTime: z("22:00") }, CREW, "Lisa", "now");
    expect(ov?.routeOverride).toBeNull();
  });

  it("an edit that does not touch the time changes nothing", () => {
    expect(overrideAfterEdit(shift(), { startTime: z("12:45"), endTime: z("22:00") }, CREW, "Lisa", "now")).toBeNull();
    expect(overrideAfterEdit(shift({ routeId: null }), { startTime: z("13:00"), endTime: z("22:00") }, CREW, "Lisa", "now")).toBeNull();
  });

  it("a time change made in Connecteam becomes an override (Nov 14: Connecteam 8:00 vs route 7:45)", () => {
    expect(connecteamOverride(shift(), { startTime: z("13:00"), endTime: z("22:00") }, CREW, "now")).toEqual({ by: "Connecteam", at: "now", source: "connecteam", routeStart: z("12:45"), routeEnd: z("22:00") });
    expect(connecteamOverride(shift(), { startTime: z("12:45"), endTime: z("22:00") }, CREW, "now")).toBeNull();
  });
});

describe("routeTimeAudit", () => {
  it("lists every route shift off its route with what will happen", () => {
    const rows = routeTimeAudit(
      [
        shift({ id: "ok" }),
        shift({ id: "kept", startTime: z("13:00"), routeOverride: OV, connecteamShiftId: "c1" }),
        shift({ id: "held", startTime: z("12:40"), connecteamShiftId: "c2" }),
        shift({ id: "draft", startTime: z("12:40") }),
        shift({ id: "noRoute", routeId: null }),
      ],
      () => CREW,
    );
    expect(rows.map((r) => [r.shiftId, r.verdict, r.overrideBy])).toEqual([
      ["kept", "override", "Lisa"],
      ["held", "held", null],
      ["draft", "will_correct", null],
    ]);
  });
});

describe("Add shift follows the route", () => {
  const route = (routeId: string, first: string, last: string): Route =>
    ({ routeId, date: D, truckId: "NPR-1", status: "planned", stops: [
      { sequence: 1, custName: "A", kind: "delivery", plannedWindow: `${D}T${first}:00.000-05:00` },
      { sequence: 2, custName: "B", kind: "pickup", plannedWindow: `${D}T${last}:00.000-05:00` },
    ] }) as unknown as Route;

  it("offers each route with its crew window (the real Nov 14 day: 8:40 AM first stop → 7:45 AM)", () => {
    const opts = buildRouteOptions([route("night", "22:30", "22:30"), route("day", "08:40", "14:40")], () => "Isuzu NPR 1");
    expect(opts.map((o) => o.label)).toEqual(["Isuzu NPR 1, 7:45 AM to 3:40 PM", "Isuzu NPR 1, 9:30 PM to 11:30 PM"]);
    expect(opts[0]).toMatchObject({ routeId: "day", start: z("12:45"), end: z("20:40") });
  });

  it("a tap opens on the route nearest the tap, and a day with no routes gives no time at all", () => {
    const opts = buildRouteOptions([route("night", "22:30", "22:30"), route("day", "08:40", "14:40")], () => "T");
    expect(routeNearest(opts, Date.parse(z("11:00")))?.routeId).toBe("day"); // 6 AM tap: nearest is the day route
    expect(routeNearest(opts, Date.parse(z("15:00")))?.routeId).toBe("day"); // 10 AM tap: inside the day route
    expect(routeNearest(opts, Date.parse("2026-11-15T01:00:00.000Z"))?.routeId).toBe("night"); // 8:00 PM tap
    expect(routeNearest([], Date.parse(z("11:00")))).toBeNull(); // no routes → no route, blank times
  });
});
