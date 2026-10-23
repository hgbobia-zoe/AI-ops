import { describe, expect, it } from "vitest";
import { decideRefresh } from "./useRouteMachine";
import type { Route, RouteStatus, Stop, StopState } from "./types";

// Pure-function coverage for the phase decision behind the "dispatch app showed no active route on arrival
// at the warehouse" bug. The driver finishes the route (ARRIVED_WAREHOUSE closes it → `done` server-side);
// if the WebView reloads / the Android activity resumes, the hook remounts with loaded=false and fetches
// the now-`done` route. Before the fix that mapped to "needsStart" (the bare Start Route screen = "no
// active route"). It must restore the route-complete recap ("returned") instead.

function stop(state: StopState, i = 1): Stop {
  const routeId = "R-1";
  return {
    stopId: `${routeId}-S${i}`,
    routeId,
    customerId: `C${i}`,
    sequence: i,
    state,
    custName: `Stop ${i}`,
    custPhone: "+15555550111",
    address: `${i} Main St`,
  };
}

function route(status: RouteStatus, states: StopState[], routeId = "R-1"): Route {
  return {
    routeId,
    date: "2026-10-23",
    truckId: "ISU",
    status,
    stops: states.map((s, i) => ({ ...stop(s, i + 1), routeId, stopId: `${routeId}-S${i + 1}` })),
  };
}

const freshMount = { loaded: false, force: false, phase: "loading" as const, routeId: null };

describe("decideRefresh — background poll protection", () => {
  it("is a no-op for a background (unforced) poll once a route is loaded", () => {
    const r = route("active", ["EnRoute", "Waiting"]);
    expect(decideRefresh(r, { loaded: true, force: false, phase: "stops", routeId: "R-1" })).toEqual({
      noop: true,
    });
  });

  it("a FORCED refresh on a loaded route still re-adopts", () => {
    const r = route("active", ["Completed", "EnRoute"]);
    const d = decideRefresh(r, { loaded: true, force: true, phase: "stops", routeId: "R-1" });
    expect(d.adopt).toBe(r);
    expect(d.phase).toBe("stops");
  });
});

describe("decideRefresh — the 'no active route on arrival' regression", () => {
  it("fresh mount + DONE route the driver worked → route-complete recap, NOT needsStart", () => {
    // Driver completed every stop then the WebView reloaded on arrival at the warehouse.
    const r = route("done", ["Completed", "Completed"]);
    const d = decideRefresh(r, freshMount);
    expect(d.phase).toBe("returned");
    expect(d.adopt).toBe(r);
    expect(d.phase).not.toBe("needsStart");
  });

  it("fresh mount + DONE route closed with some stops still unfinished → still a recap (honest 'partial')", () => {
    const r = route("done", ["Completed", "Waiting"]);
    const d = decideRefresh(r, freshMount);
    expect(d.phase).toBe("returned");
    expect(d.adopt).toBe(r);
  });

  it("fresh mount + DONE route with an Arrived/Exception stop (worked, not completed) → recap", () => {
    expect(decideRefresh(route("done", ["Arrived"]), freshMount).phase).toBe("returned");
    expect(decideRefresh(route("done", ["Exception", "Waiting"]), freshMount).phase).toBe("returned");
    expect(decideRefresh(route("done", ["Returned"]), freshMount).phase).toBe("returned");
  });

  it("fresh mount + DONE route the driver NEVER touched (office force-closed) → needsStart (invite a pull)", () => {
    const r = route("done", ["Waiting", "Waiting"]);
    const d = decideRefresh(r, freshMount);
    expect(d.phase).toBe("needsStart");
    expect(d.adopt).toBeUndefined();
  });

  it("IN-SESSION done (loaded, just closed out) → leaves the recap untouched (no stomp)", () => {
    // After ARRIVED_WAREHOUSE the phase is already "returned"; the follow-up forced refresh sees `done`.
    const r = route("done", ["Completed"]);
    const d = decideRefresh(r, { loaded: true, force: true, phase: "returned", routeId: "R-1" });
    expect(d).toEqual({});
    expect(d.phase).toBeUndefined();
  });
});

describe("decideRefresh — no route / loading states", () => {
  it("fresh mount + no route → needsStart", () => {
    expect(decideRefresh(null, freshMount)).toEqual({ phase: "needsStart" });
  });

  it("loaded + server returns null → no change (never yanks a working driver to Start)", () => {
    expect(decideRefresh(null, { loaded: true, force: true, phase: "stops", routeId: "R-1" })).toEqual({});
  });

  it("scraping always shows the loading screen", () => {
    expect(decideRefresh(route("scraping", []), freshMount).phase).toBe("scraping");
  });

  it("failed → manual-entry fallback only before anything is loaded", () => {
    expect(decideRefresh(route("failed", []), freshMount).phase).toBe("failed");
    expect(decideRefresh(route("failed", []), { loaded: true, force: true, phase: "stops", routeId: "R-1" })).toEqual({});
  });
});

describe("decideRefresh — active route adoption + closeout preservation", () => {
  it("fresh mount + active route → adopt into stops (an active route survives a reload)", () => {
    const r = route("active", ["Completed", "EnRoute", "Waiting"]);
    const d = decideRefresh(r, freshMount);
    expect(d.adopt).toBe(r);
    expect(d.phase).toBe("stops");
  });

  it("ready route with no stops → empty", () => {
    expect(decideRefresh(route("ready", []), freshMount).phase).toBe("empty");
  });

  it("forced re-pull during headingBack (all stops Completed) must NOT stomp the closeout phase", () => {
    const r = route("active", ["Completed", "Completed"]);
    const d = decideRefresh(r, { loaded: true, force: true, phase: "headingBack", routeId: "R-1" });
    expect(d.adopt).toBe(r);
    expect(d.phase).toBe("headingBack");
  });

  it("a genuinely new active stop on the SAME route during headingBack falls through to stops", () => {
    const r = route("active", ["Completed", "EnRoute"]); // a mid-day add → not all Completed
    const d = decideRefresh(r, { loaded: true, force: true, phase: "headingBack", routeId: "R-1" });
    expect(d.phase).toBe("stops");
  });

  it("on the closeout screen, a DIFFERENT active route is HELD as nextRoute, not adopted", () => {
    const next = route("ready", ["Waiting"], "R-2");
    const d = decideRefresh(next, { loaded: true, force: true, phase: "returned", routeId: "R-1" });
    expect(d.holdNext).toBe(next);
    expect(d.adopt).toBeUndefined();
    expect(d.phase).toBeUndefined();
  });
});
