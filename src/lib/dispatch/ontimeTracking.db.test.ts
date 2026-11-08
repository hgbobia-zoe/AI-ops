import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slack + fan-out are network side effects: stub them so the routes under test stay hermetic.
const slackNotify = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/notify/slack", () => ({ slackNotify: (t: string) => slackNotify(t) }));
vi.mock("@/lib/notify/fanout", () => ({ runFanout: vi.fn(async () => {}) }));

import {
  applyBookingWindows,
  getRouteById,
  getStop,
  saveBookings,
  setStopProof,
  syncStopWindowsFromBookings,
  writeRoute,
} from "@/lib/db/repo";
import { applyCloseResolutions } from "./closeRoute";
import type { Route, Stop } from "@/lib/types";

// DATABASE_PATH is ":memory:" (vitest.config.ts): a throwaway DB per file.

function stop(routeId: string, stopId: string, seq: number, o: Partial<Stop> = {}): Stop {
  return { stopId, routeId, customerId: `C${seq}`, sequence: seq, state: "Waiting", custName: `Cust ${seq}`, custPhone: "+15555550100", address: `${seq} Main St`, txId: `TX${seq}`, ...o };
}

describe("customer window from the Goodshuffle project (bookings feed)", () => {
  it("fills a delivery stop's window from logistics_start_from_time, not a pickup's", () => {
    saveBookings([
      { bookingId: "231944361", eventName: "Palmer", eventDate: "2026-10-30", windowStartTime: "9:00 AM EDT" },
      { bookingId: "PU1", eventName: "Pickup", eventDate: "2026-10-30", windowStartTime: "2:00 PM EDT" },
    ]);
    const routeId = "R-2026-10-30-E450-65572";
    const stops = applyBookingWindows(
      [
        stop(routeId, "P1", 1, { txId: "231944361", kind: "delivery", plannedWindow: "2026-10-30T11:05:00.000-04:00" }),
        stop(routeId, "P2", 2, { txId: "PU1", kind: "pickup" }),
      ],
      "2026-10-30",
    );
    writeRoute({ routeId, date: "2026-10-30", truckId: "E450", status: "ready", gsRouteId: "65572", stops });
    const s1 = getStop("P1");
    expect(s1?.windowStart).toBe("2026-10-30T13:00:00.000Z");
    expect(s1?.windowSource).toBe("booking");
    expect(s1?.plannedWindow).toBe("2026-10-30T11:05:00.000-04:00"); // planned arrival kept separate
    expect(getStop("P2")?.windowStart).toBeUndefined();
  });

  it("a waypoint window from the pull wins over the project window", () => {
    saveBookings([{ bookingId: "TXW", eventDate: "2026-10-31", windowStartTime: "9:00 AM EDT" }]);
    const out = applyBookingWindows(
      [stop("R", "W1", 1, { txId: "TXW", windowStart: "2026-10-31T15:00:00.000Z", windowSource: "route" })],
      "2026-10-31",
    );
    expect(out[0].windowStart).toBe("2026-10-31T15:00:00.000Z");
    expect(out[0].windowSource).toBe("route");
  });

  it("backfills routes already written when the bookings pull lands later", () => {
    const routeId = "R-2026-10-31-NPR-1-65573";
    writeRoute({
      routeId, date: "2026-10-31", truckId: "NPR-1", status: "done", gsRouteId: "65573",
      stops: [stop(routeId, "G1", 1, { txId: "231884561", kind: "delivery", plannedOnSiteMin: 60, plannedTransitMin: 28 })],
    });
    expect(getStop("G1")?.windowStart).toBeUndefined();
    saveBookings([{ bookingId: "231884561", eventName: "McGahn", eventDate: "2026-10-31", windowStartTime: "9:00 AM EDT" }]);
    expect(syncStopWindowsFromBookings("2026-09-01")).toBe(1);
    expect(getStop("G1")).toMatchObject({ windowStart: "2026-10-31T13:00:00.000Z", windowSource: "booking", plannedOnSiteMin: 60, plannedTransitMin: 28 });
    // Idempotent.
    expect(syncStopWindowsFromBookings("2026-09-01")).toBe(0);
    // An older pull build that does not send the time keeps the stored one; a later "TBD" clears it.
    saveBookings([{ bookingId: "231884561", eventName: "McGahn", eventDate: "2026-10-31" }]);
    expect(syncStopWindowsFromBookings("2026-09-01")).toBe(0);
    saveBookings([{ bookingId: "231884561", eventName: "McGahn", eventDate: "2026-10-31", windowStartTime: "TBD" }]);
    expect(syncStopWindowsFromBookings("2026-09-01")).toBe(1);
    expect(getStop("G1")?.windowStart).toBeUndefined();
  });
});

describe("closing a route with stops not completed", () => {
  beforeEach(() => slackNotify.mockClear());
  afterEach(() => vi.clearAllMocks());

  function seed(routeId: string): Route {
    const r: Route = {
      routeId, date: "2026-10-30", truckId: "NPR-1", status: "active", gsRouteId: routeId.split("-").pop(), driverName: undefined,
      stops: [
        stop(routeId, `${routeId}-A`, 1, { state: "Arrived", arrivedAt: "2026-10-30T14:40:00.000Z", custName: "Palmer" }),
        stop(routeId, `${routeId}-B`, 2, { state: "Waiting", custName: "McGahn" }),
        stop(routeId, `${routeId}-C`, 3, { state: "Completed", custName: "Done Co" }),
      ],
    };
    writeRoute(r);
    return r;
  }

  it("records the reason, marks completed without faking a tap, and a re-pull keeps both", () => {
    const routeId = "R-2026-10-30-NPR-1-801";
    seed(routeId);
    setStopProof(`${routeId}-C`, { photoIds: ["pod-1"] });
    const applied = applyCloseResolutions(
      routeId,
      [
        { stopId: `${routeId}-A`, action: "completed" },
        { stopId: `${routeId}-B`, action: "reason", reason: "Customer asked to move it to Monday" },
      ],
      "Dana (office)",
      null,
      "2026-10-30T22:00:00.000Z",
    );
    expect(applied.map((a) => a.resolution)).toEqual(["marked_completed", "reason"]);
    expect(getStop(`${routeId}-A`)).toMatchObject({ state: "Completed", completedAt: "2026-10-30T22:00:00.000Z", closeResolution: "marked_completed", closeBy: "Dana (office)" });
    expect(getStop(`${routeId}-B`)).toMatchObject({ state: "Waiting", closeResolution: "reason", closeReason: "Customer asked to move it to Monday" });

    // A later Goodshuffle re-pull rewrites the stops: close resolutions and POD survive.
    const now = getRouteById(routeId)!;
    writeRoute({ ...now, stops: now.stops.map((s) => ({ ...s, closeResolution: undefined, closeReason: undefined, closeBy: undefined, closeAt: undefined, photoIds: undefined })) });
    expect(getStop(`${routeId}-B`)?.closeReason).toBe("Customer asked to move it to Monday");
    expect(getStop(`${routeId}-C`)?.photoIds).toEqual(["pod-1"]);
  });

  it("never blocks: a stop with no choice is recorded as closed with no reason", () => {
    const routeId = "R-2026-10-30-NPR-1-802";
    seed(routeId);
    const applied = applyCloseResolutions(routeId, [{ stopId: `${routeId}-B`, action: "reason", reason: " " }], "the driver");
    expect(applied.every((a) => a.resolution === "none")).toBe(true);
    expect(getStop(`${routeId}-A`)).toMatchObject({ state: "Arrived", closeResolution: "none", closeBy: "the driver" });
  });

  it("driver ARRIVED_WAREHOUSE records the per-stop reasons and names them in Slack", async () => {
    const routeId = "R-2026-10-30-NPR-1-803";
    seed(routeId);
    const { POST } = await import("@/app/api/action/route");
    const res = await POST(
      new Request("http://localhost/api/action", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "idem-ontime-803",
          action: "ARRIVED_WAREHOUSE",
          fromState: "HeadingBack",
          stopId: routeId,
          routeId,
          truckId: "NPR-1",
          payload: {
            stopResolutions: [
              { stopId: `${routeId}-A`, action: "reason", reason: "Install not finished, crew coming back tomorrow" },
              { stopId: `${routeId}-B`, action: "completed" },
            ],
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(getRouteById(routeId)?.status).toBe("done");
    expect(getStop(`${routeId}-A`)?.closeReason).toBe("Install not finished, crew coming back tomorrow");
    expect(getStop(`${routeId}-B`)?.closeResolution).toBe("marked_completed");
    const texts = slackNotify.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(texts.some((t) => t.includes("Palmer") && t.includes("Install not finished"))).toBe(true);
    expect(texts.some((t) => t.includes("marked 1 stop completed at closeout without a driver tap") && t.includes("McGahn"))).toBe(true);
  });

  it("a repeat close never rewrites the first closer's record", () => {
    const routeId = "R-2026-10-30-NPR-1-804";
    seed(routeId);
    applyCloseResolutions(routeId, [{ stopId: `${routeId}-B`, action: "reason", reason: "First reason" }], "First closer");
    writeRoute({ ...getRouteById(routeId)!, status: "done" });
    expect(applyCloseResolutions(routeId, [{ stopId: `${routeId}-B`, action: "reason", reason: "Second" }], "Second closer")).toEqual([]);
    expect(getStop(`${routeId}-B`)).toMatchObject({ closeReason: "First reason", closeBy: "First closer" });
  });
});
