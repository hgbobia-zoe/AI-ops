import { describe, expect, it } from "vitest";
import {
  pickWorkableRoute,
  planTruckHandoff,
  isVerifiedComplete,
  incompleteStopCount,
  clampBufferMinutes,
} from "./handoff";
import type { Route, RouteStatus, StopState } from "@/lib/types";

const DAY = "2026-10-02";

function route(id: string, status: RouteStatus, startIso: string | undefined, states: StopState[]): Route {
  return {
    routeId: id,
    date: DAY,
    truckId: "T1",
    status,
    stops: states.map((state, i) => ({
      stopId: `${id}-s${i + 1}`,
      routeId: id,
      customerId: "C",
      sequence: i + 1,
      state,
      custName: "Cust",
      custPhone: "+15555550111",
      address: "1 Main St",
      plannedWindow: i === 0 ? startIso : undefined, // start time on the first stop
    })),
  };
}

const ms = (iso: string) => Date.parse(iso);

describe("pickWorkableRoute — handoff visibility", () => {
  const dayR = route("DAY", "active", `${DAY}T14:00:00.000Z`, ["Waiting"]);
  const eveR = route("EVE", "ready", `${DAY}T23:00:00.000Z`, ["Waiting"]);

  it("without handoff, always returns the earliest-starting workable route", () => {
    const pick = pickWorkableRoute([eveR, dayR], ms(`${DAY}T23:30:00.000Z`), 20, false);
    expect(pick?.routeId).toBe("DAY");
  });

  it("before any handoff window, returns the earliest even with handoff on", () => {
    const pick = pickWorkableRoute([dayR, eveR], ms(`${DAY}T10:00:00.000Z`), 20, true);
    expect(pick?.routeId).toBe("DAY");
  });

  it("surfaces the LATER route once its window opens, even though the earlier route is still open (the fix)", () => {
    // 20 min before EVE's 23:00 start = 22:40; at 22:45 the evening driver must see EVE, not the open DAY route.
    const pick = pickWorkableRoute([dayR, eveR], ms(`${DAY}T22:45:00.000Z`), 20, true);
    expect(pick?.routeId).toBe("EVE");
  });

  it("stays on the earlier route inside its own window before the next window opens", () => {
    const pick = pickWorkableRoute([dayR, eveR], ms(`${DAY}T15:00:00.000Z`), 20, true);
    expect(pick?.routeId).toBe("DAY");
  });

  it("never auto-selects a route with no scheduled time when a timed route's window is open", () => {
    const untimed = route("NOTIME", "ready", undefined, ["Waiting"]);
    const pick = pickWorkableRoute([dayR, untimed], ms(`${DAY}T15:00:00.000Z`), 20, true);
    expect(pick?.routeId).toBe("DAY");
  });

  it("returns the single workable route, and null for none", () => {
    expect(pickWorkableRoute([dayR], ms(`${DAY}T10:00:00.000Z`), 20, true)?.routeId).toBe("DAY");
    expect(pickWorkableRoute([], ms(`${DAY}T10:00:00.000Z`), 20, true)).toBeNull();
  });
});

describe("planTruckHandoff — reconcile the stale earlier route", () => {
  const nextStart = `${DAY}T23:00:00.000Z`;
  const inWindow = ms(`${DAY}T22:45:00.000Z`);
  const beforeWindow = ms(`${DAY}T20:00:00.000Z`);

  it("Scenario A: verified-complete earlier route → FINALIZE", () => {
    const prior = route("DAY", "active", `${DAY}T14:00:00.000Z`, ["Completed", "Returned"]);
    const next = route("EVE", "ready", nextStart, ["Waiting"]);
    const plan = planTruckHandoff([prior, next], inWindow, 20);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ kind: "finalize", routeId: "DAY", reason: "verified_complete" });
  });

  it("Scenario B: unverified earlier route with an ACTIVE stop → FLAG + conflict", () => {
    const prior = route("DAY", "active", `${DAY}T14:00:00.000Z`, ["Completed", "Arrived"]);
    const next = route("EVE", "ready", nextStart, ["Waiting"]);
    const plan = planTruckHandoff([prior, next], inWindow, 20);
    expect(plan.actions[0]).toMatchObject({ kind: "flag", conflict: true, incomplete: 1, reason: "active_truck_unverified" });
  });

  it("Scenario B: unverified but idle (only waiting) → FLAG, no conflict", () => {
    const prior = route("DAY", "active", `${DAY}T14:00:00.000Z`, ["Completed", "Waiting"]);
    const next = route("EVE", "ready", nextStart, ["Waiting"]);
    const plan = planTruckHandoff([prior, next], inWindow, 20);
    expect(plan.actions[0]).toMatchObject({ kind: "flag", conflict: false, reason: "window_passed_unverified" });
  });

  it("does nothing before the next route's handoff window opens", () => {
    const prior = route("DAY", "active", `${DAY}T14:00:00.000Z`, ["Waiting"]);
    const next = route("EVE", "ready", nextStart, ["Waiting"]);
    expect(planTruckHandoff([prior, next], beforeWindow, 20).actions).toHaveLength(0);
  });

  it("does nothing when the earlier route is already done", () => {
    const prior = route("DAY", "done", `${DAY}T14:00:00.000Z`, ["Completed"]);
    const next = route("EVE", "ready", nextStart, ["Waiting"]);
    expect(planTruckHandoff([prior, next], inWindow, 20).actions).toHaveLength(0);
  });

  it("defers when the next route has no scheduled start (never invents a window)", () => {
    const prior = route("DAY", "active", `${DAY}T14:00:00.000Z`, ["Completed"]);
    const next = route("EVE", "ready", undefined, ["Waiting"]);
    expect(planTruckHandoff([prior, next], inWindow, 20).actions).toHaveLength(0);
  });

  it("cascades across three routes (two earlier ones hand off once the last window opens)", () => {
    const r1 = route("R1", "active", `${DAY}T09:00:00.000Z`, ["Completed", "Returned"]); // verified
    const r2 = route("R2", "active", `${DAY}T15:00:00.000Z`, ["Arrived"]); // active, unverified
    const r3 = route("R3", "ready", `${DAY}T21:00:00.000Z`, ["Waiting"]);
    const plan = planTruckHandoff([r1, r2, r3], ms(`${DAY}T20:50:00.000Z`), 20);
    // r1→(r2 window long open) finalize; r2→(r3 window open at 20:40) flag+conflict
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0]).toMatchObject({ kind: "finalize", routeId: "R1" });
    expect(plan.actions[1]).toMatchObject({ kind: "flag", routeId: "R2", conflict: true });
  });
});

describe("evidence + buffer helpers", () => {
  it("isVerifiedComplete requires at least one stop, all terminal", () => {
    expect(isVerifiedComplete(route("a", "active", undefined, ["Completed", "Returned"]))).toBe(true);
    expect(isVerifiedComplete(route("a", "active", undefined, ["Completed", "Arrived"]))).toBe(false);
    expect(isVerifiedComplete(route("a", "active", undefined, []))).toBe(false);
  });

  it("incompleteStopCount counts non-terminal stops", () => {
    expect(incompleteStopCount(route("a", "active", undefined, ["Completed", "Arrived", "Waiting"]))).toBe(2);
  });

  it("clampBufferMinutes enforces the 15-30 range", () => {
    expect(clampBufferMinutes(20, 20)).toBe(20);
    expect(clampBufferMinutes(15, 20)).toBe(15);
    expect(clampBufferMinutes(30, 20)).toBe(30);
    expect(clampBufferMinutes(10, 20)).toBe(20);
    expect(clampBufferMinutes(31, 20)).toBe(20);
    expect(clampBufferMinutes("abc", 20)).toBe(20);
  });
});
