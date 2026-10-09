import { describe, it, expect } from "vitest";
import {
  isPreMintableStop,
  isDeliveryStop,
  hasUpcomingDeliveries,
  selectStopsToPreMint,
  preMintWindow,
  stopScheduledISO,
  PREMINT_MAX_WINDOW_H,
  type RouteForPreMint,
} from "./preMint";
import type { Route, Stop, StopState } from "@/lib/types";

function stop(over: Partial<Stop> = {}): Stop {
  return {
    stopId: "S-1",
    routeId: "R-1",
    customerId: "C-1",
    sequence: 1,
    state: "Waiting" as StopState,
    custName: "Smith - Wedding",
    custPhone: "+13015550123",
    address: "111 Rockville Pike, Rockville, MD 20850",
    kind: "delivery",
    ...over,
  };
}

function route(stops: Stop[], over: Partial<Route> = {}): Route {
  return { routeId: "R-1", date: "2026-10-05", truckId: "E450", status: "ready", stops, ...over };
}

const NOW = new Date("2026-10-05T14:00:00.000Z");

describe("isPreMintableStop — which stops qualify", () => {
  it("an upcoming (Waiting) stop with an address and a phone qualifies", () => {
    expect(isPreMintableStop(stop({ state: "Waiting" }))).toBe(true);
    expect(isPreMintableStop(stop({ state: "EnRoute" }))).toBe(true);
  });

  it("a completed/arrived/returned stop is NOT pre-minted (not upcoming)", () => {
    for (const s of ["Arrived", "Completed", "Returned", "HeadingBack", "Exception"] as StopState[]) {
      expect(isPreMintableStop(stop({ state: s }))).toBe(false);
    }
  });

  it("no usable address → not pre-minted (can't geocode)", () => {
    expect(isPreMintableStop(stop({ address: "" }))).toBe(false);
    expect(isPreMintableStop(stop({ address: "   " }))).toBe(false);
  });

  it("no one to text (no customer and no day-of phone) → not pre-minted", () => {
    expect(isPreMintableStop(stop({ custPhone: "", dayOfPhone: undefined }))).toBe(false);
  });

  it("a day-of coordinator phone alone is enough", () => {
    expect(isPreMintableStop(stop({ custPhone: "", dayOfPhone: "+13015559999" }))).toBe(true);
  });
});

describe("isDeliveryStop / hasUpcomingDeliveries — the alert gate", () => {
  it("delivery or unknown kind counts as a delivery; explicit pickup does not", () => {
    expect(isDeliveryStop(stop({ kind: "delivery" }))).toBe(true);
    expect(isDeliveryStop(stop({ kind: undefined }))).toBe(true);
    expect(isDeliveryStop(stop({ kind: "pickup" }))).toBe(false);
  });

  it("true only when a route has an upcoming delivery that would send a link", () => {
    expect(hasUpcomingDeliveries([route([stop({ kind: "delivery", state: "Waiting" })])])).toBe(true);
    // only pickups → no delivery to track
    expect(hasUpcomingDeliveries([route([stop({ kind: "pickup" })])])).toBe(false);
    // delivery but already completed → nothing upcoming
    expect(hasUpcomingDeliveries([route([stop({ kind: "delivery", state: "Completed" })])])).toBe(false);
    // no routes at all → false
    expect(hasUpcomingDeliveries([])).toBe(false);
  });
});

describe("stopScheduledISO — real times only, never fabricated", () => {
  it("prefers eta, then plannedWindow, when they are real ISO datetimes", () => {
    expect(stopScheduledISO(stop({ eta: "2026-10-05T19:00:00.000-04:00" }))).toBe("2026-10-05T19:00:00.000-04:00");
    expect(stopScheduledISO(stop({ eta: undefined, plannedWindow: "2026-10-05T09:00:00.000-04:00" }))).toBe("2026-10-05T09:00:00.000-04:00");
  });
  it("free-text windows are NOT treated as a time", () => {
    expect(stopScheduledISO(stop({ eta: "morning", plannedWindow: "1-3 PM" }))).toBeNull();
    expect(stopScheduledISO(stop({ eta: undefined, plannedWindow: undefined }))).toBeNull();
  });
});

describe("selectStopsToPreMint — today vs early-tomorrow", () => {
  const todayRoute = (s: Stop[]): RouteForPreMint => ({ route: route(s), truckId: "E450", truckLabel: "Ford E450", isToday: true });
  const tomorrowRoute = (s: Stop[]): RouteForPreMint => ({ route: route(s, { date: "2026-10-06" }), truckId: "E450", truckLabel: "Ford E450", isToday: false });

  it("today: every upcoming pre-mintable stop, timed or not", () => {
    const plan = selectStopsToPreMint({
      routes: [todayRoute([stop({ stopId: "A", eta: undefined, plannedWindow: undefined }), stop({ stopId: "B", eta: "2026-10-05T19:00:00.000-04:00" })])],
      now: NOW,
    });
    expect(plan.map((p) => p.stop.stopId)).toEqual(["A", "B"]);
  });

  it("tomorrow: stops within the ~22h horizon are pre-minted (covers late-night / early-next-day departures); farther-out + untimed are skipped", () => {
    const soon = "2026-10-05T22:00:00.000Z"; // 8h after NOW
    const night = "2026-10-06T08:00:00.000Z"; // 18h after NOW — e.g. a 1am pickup after an evening event
    const late = "2026-10-06T20:00:00.000Z"; // 30h after NOW → beyond the coverable window
    const plan = selectStopsToPreMint({
      routes: [
        tomorrowRoute([
          stop({ stopId: "SOON", eta: soon }),
          stop({ stopId: "NIGHT", eta: night }),
          stop({ stopId: "LATE", eta: late }),
          stop({ stopId: "UNTIMED", eta: undefined, plannedWindow: undefined }),
        ]),
      ],
      now: NOW,
    });
    expect(plan.map((p) => p.stop.stopId)).toEqual(["SOON", "NIGHT"]);
  });

  it("skips non-upcoming / unaddressed stops regardless of day", () => {
    const plan = selectStopsToPreMint({
      routes: [todayRoute([stop({ stopId: "DONE", state: "Completed" }), stop({ stopId: "NOADDR", address: "" })])],
      now: NOW,
    });
    expect(plan).toHaveLength(0);
  });
});

describe("preMintWindow — validity window math", () => {
  const fallbackEndISO = "2026-10-06T03:59:59.999Z"; // end of the ops day (≈ 11:59pm ET)

  it("a timed stop → window ends at stop time + buffer (default 3h)", () => {
    const w = preMintWindow({ now: NOW, stopTimeISO: "2026-10-05T19:00:00.000Z", fallbackEndISO, minWindowH: 8 });
    // 19:00Z + 3h buffer = 22:00Z. NOW is 14:00Z → 8h window (> the 8h floor, so not floored).
    expect(w.endISO).toBe("2026-10-05T22:00:00.000Z");
    expect(w.startISO).toBe("2026-10-05T14:00:00.000Z");
  });

  it("a near/just-past stop is floored at the minimum window so the link is still usable", () => {
    const w = preMintWindow({ now: NOW, stopTimeISO: "2026-10-05T13:30:00.000Z", fallbackEndISO, minWindowH: 8 });
    // stop+buffer = 16:30Z (only 2.5h out) → floored to NOW + 8h = 22:00Z.
    expect(w.endISO).toBe("2026-10-05T22:00:00.000Z");
    expect(w.hours).toBeCloseTo(8, 5);
  });

  it("a far-future stop is clamped to the max window (≤24h)", () => {
    const w = preMintWindow({ now: NOW, stopTimeISO: "2026-10-10T19:00:00.000Z", fallbackEndISO, minWindowH: 8, maxH: PREMINT_MAX_WINDOW_H });
    expect(w.hours).toBeCloseTo(PREMINT_MAX_WINDOW_H, 5);
    expect(w.endISO).toBe("2026-10-06T14:00:00.000Z"); // NOW + 24h
  });

  it("an untimed stop falls back to end-of-day (never fabricates a stop time)", () => {
    const w = preMintWindow({ now: NOW, stopTimeISO: null, fallbackEndISO, minWindowH: 8 });
    expect(w.endISO).toBe(fallbackEndISO);
  });
});
