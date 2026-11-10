import { describe, expect, it, vi } from "vitest";

// Slack is a network side effect: stub it so the routes under test stay hermetic.
vi.mock("@/lib/notify/slack", () => ({ slackNotify: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/notify/fanout", () => ({ runFanout: vi.fn(async () => {}) }));

import {
  applyBookingWindows,
  getBookingTimelineWindows,
  getRouteById,
  getStop,
  recordStopCloseResolution,
  saveBookingTimelineWindows,
  saveBookings,
  setStopProof,
  syncStopWindowsFromBookings,
  writeRoute,
} from "@/lib/db/repo";
import { scoreOnTime } from "./onTime";
import type { Stop } from "@/lib/types";

// DATABASE_PATH is ":memory:" (vitest.config.ts): a throwaway DB per file.
// Delivery windows are RANGES from the Goodshuffle project timeline (initProjectTimeline), verified live
// 2026-11-10 on the real Oct 31 / Nov 7 projects.

function stop(routeId: string, stopId: string, seq: number, o: Partial<Stop> = {}): Stop {
  return { stopId, routeId, customerId: `C${seq}`, sequence: seq, state: "Waiting", custName: `Cust ${seq}`, custPhone: "+15555550100", address: `${seq} Main St`, ...o };
}

const MCGAHN = "231884561";
const MONTEALEGRE = "231884562";
const GAMARRA = "231884563";
const PICKUP_ONLY = "231884564";

function seedProjects(): void {
  saveBookings([
    { bookingId: MCGAHN, eventName: "McGahn", eventDate: "2026-10-31", windowStartTime: "9:00 AM EDT" },
    { bookingId: MONTEALEGRE, eventName: "Montealegre", eventDate: "2026-10-31", windowStartTime: "9:00 AM EDT" },
    { bookingId: GAMARRA, eventName: "Gamarra", eventDate: "2026-11-07", windowStartTime: "8:00 AM EST" },
    { bookingId: PICKUP_ONLY, eventName: "Customer pickup", eventDate: "2026-11-07", windowStartTime: "10:00 AM EST" },
  ]);
  saveBookingTimelineWindows(
    [
      {
        bookingId: MCGAHN,
        events: [
          { marker: "DROP_OFF", name: "Delivery fee", dateLabel: "Saturday, 10/31 [9:00 AM - 8:00 PM]" },
          { marker: "PICK_UP", name: "Delivery fee", dateLabel: "Monday, 11/2 [9:00 AM - 7:15 PM]" },
        ],
      },
      {
        bookingId: MONTEALEGRE,
        events: [
          { marker: "DROP_OFF", name: "PIN POINT EXACT TIME", dateLabel: "Saturday, 10/31 [9:00 AM - 10:00 AM]" },
          { marker: "DROP_OFF", name: "Event Readiness Service", dateLabel: "Saturday, 10/31 [10:15 AM]" },
          { marker: "PICK_UP", name: "PIN POINT EXACT TIME", dateLabel: "Monday, 11/2 [10:00 AM - 12:00 PM]" },
        ],
      },
      {
        bookingId: GAMARRA,
        events: [
          { marker: "DROP_OFF", name: "Delivery fee", dateLabel: "Saturday, 11/7 [8:00 AM - 10:00 AM]" },
          { marker: "PICK_UP", name: "Delivery fee", dateLabel: "Tuesday, 11/10 [9:00 AM - 8:00 PM]" },
        ],
      },
      { bookingId: PICKUP_ONLY, events: [] },
    ],
    "2026-11-10",
  );
}

describe("project timeline windows (booking_windows)", () => {
  it("stores every logistics entry, years from the logistics date, the exact time flagged", () => {
    seedProjects();
    const w = getBookingTimelineWindows([MCGAHN, MONTEALEGRE, PICKUP_ONLY]);
    expect(w.get(MCGAHN)?.map((x) => [x.kind, x.date, x.startTime, x.endTime])).toEqual([
      ["drop_off", "2026-10-31", "9:00 AM", "8:00 PM"],
      ["pick_up", "2026-11-02", "9:00 AM", "7:15 PM"],
    ]);
    expect(w.get(MONTEALEGRE)?.filter((x) => x.pinPoint).length).toBe(2);
    expect(w.get(PICKUP_ONLY)).toBeUndefined();
  });

  it("the real Oct 31 deliveries: McGahn on time at 1:44 PM, Montealegre held to its exact time", () => {
    seedProjects();
    const routeId = "R-2026-10-31-NPR-1-65573";
    const stops = applyBookingWindows(
      [
        stop(routeId, "OT-M", 1, { txId: MONTEALEGRE, kind: "delivery", custName: "Montealegre" }),
        stop(routeId, "OT-G", 2, { txId: MCGAHN, kind: "delivery", custName: "McGahn", arrivedAt: "2026-10-31T17:44:00.000Z" }),
      ],
      "2026-10-31",
    );
    writeRoute({ routeId, date: "2026-10-31", truckId: "NPR-1", status: "ready", gsRouteId: "65573", stops });
    const g = getStop("OT-G")!;
    expect(g).toMatchObject({ windowStart: "2026-10-31T13:00:00.000Z", windowEnd: "2026-11-01T00:00:00.000Z", windowSource: "booking", windowLabel: "Delivery fee" });
    expect(g.windowPinPoint).toBeUndefined();
    expect(scoreOnTime({ windowStart: g.windowStart, windowEnd: g.windowEnd, pinPoint: g.windowPinPoint, appArrivedAt: g.arrivedAt })).toMatchObject({
      status: "on_time",
      minutesLate: -376,
    });
    const m = getStop("OT-M")!;
    expect(m).toMatchObject({ windowStart: "2026-10-31T13:00:00.000Z", windowEnd: "2026-10-31T14:00:00.000Z", windowPinPoint: true, windowLabel: "PIN POINT EXACT TIME" });
  });

  it("pickups are scored from the PICK_UP window on their own day", () => {
    seedProjects();
    const routeId = "R-2026-11-02-E450-65600";
    const stops = applyBookingWindows(
      [
        stop(routeId, "PU-G", 1, { txId: MCGAHN, kind: "pickup" }),
        stop(routeId, "PU-M", 2, { txId: MONTEALEGRE, kind: "pickup" }),
      ],
      "2026-11-02",
    );
    expect(stops[0]).toMatchObject({ windowStart: "2026-11-02T14:00:00.000Z", windowEnd: "2026-11-03T00:15:00.000Z" });
    expect(stops[1]).toMatchObject({ windowStart: "2026-11-02T15:00:00.000Z", windowEnd: "2026-11-02T17:00:00.000Z", windowPinPoint: true });
  });

  it("Nov 7 Gamarra: drop off 8:00 to 10:00 AM; a customer pickup project falls back to the start only", () => {
    seedProjects();
    const out = applyBookingWindows(
      [
        stop("R7", "N7-G", 1, { txId: GAMARRA, kind: "delivery" }),
        stop("R7", "N7-P", 2, { txId: PICKUP_ONLY, kind: "delivery" }),
      ],
      "2026-11-07",
    );
    expect(out[0]).toMatchObject({ windowStart: "2026-11-07T13:00:00.000Z", windowEnd: "2026-11-07T15:00:00.000Z" });
    expect(out[1]).toMatchObject({ windowStart: "2026-11-07T15:00:00.000Z", windowSource: "booking" });
    expect(out[1].windowEnd).toBeUndefined();
  });

  it("a waypoint range from the route pull still wins; a start only waypoint gives way to the timeline range", () => {
    seedProjects();
    const out = applyBookingWindows(
      [
        stop("RW", "W-1", 1, { txId: MCGAHN, kind: "delivery", windowStart: "2026-10-31T15:00:00.000Z", windowEnd: "2026-10-31T16:00:00.000Z", windowSource: "route" }),
        stop("RW", "W-2", 2, { txId: MCGAHN, kind: "delivery", windowStart: "2026-10-31T15:00:00.000Z", windowSource: "route" }),
      ],
      "2026-10-31",
    );
    expect(out[0]).toMatchObject({ windowStart: "2026-10-31T15:00:00.000Z", windowEnd: "2026-10-31T16:00:00.000Z", windowSource: "route" });
    expect(out[1]).toMatchObject({ windowStart: "2026-10-31T13:00:00.000Z", windowEnd: "2026-11-01T00:00:00.000Z", windowSource: "booking" });
  });

  it("a timeline landing after the route backfills the stop's end and exact time, keeping POD and the close reason", () => {
    saveBookings([{ bookingId: "TL-LATE", eventName: "Late timeline", eventDate: "2026-11-07", windowStartTime: "9:00 AM EST" }]);
    const routeId = "R-2026-11-07-NPR-2-70001";
    writeRoute({
      routeId, date: "2026-11-07", truckId: "NPR-2", status: "ready", gsRouteId: "70001",
      stops: applyBookingWindows([stop(routeId, "TL-1", 1, { txId: "TL-LATE", kind: "delivery", state: "Completed" })], "2026-11-07"),
    });
    expect(getStop("TL-1")).toMatchObject({ windowStart: "2026-11-07T14:00:00.000Z" });
    expect(getStop("TL-1")?.windowEnd).toBeUndefined();
    setStopProof("TL-1", { photoIds: ["pod-tl-1"], signatureId: "sig-tl-1" });
    recordStopCloseResolution("TL-1", { resolution: "reason", reason: "Gate locked, left at the side door", by: "Dana (office)", at: "2026-11-07T22:00:00.000Z" });

    saveBookingTimelineWindows([{ bookingId: "TL-LATE", events: [{ marker: "DROP_OFF", name: "PIN POINT EXACT TIME", dateLabel: "Saturday, 11/7 [9:00 AM - 10:00 AM]" }] }], "2026-11-10");
    expect(syncStopWindowsFromBookings("2026-11-01")).toBe(1);
    expect(getStop("TL-1")).toMatchObject({
      windowStart: "2026-11-07T14:00:00.000Z",
      windowEnd: "2026-11-07T15:00:00.000Z",
      windowPinPoint: true,
      photoIds: ["pod-tl-1"],
      signatureId: "sig-tl-1",
      closeReason: "Gate locked, left at the side door",
    });
    expect(syncStopWindowsFromBookings("2026-11-01")).toBe(0); // idempotent

    // A re-pull of the route (stops arrive without POD, close reason or window flags) keeps all of it.
    const now = getRouteById(routeId)!;
    const repulled = now.stops.map((s) => ({ ...s, photoIds: undefined, signatureId: undefined, closeReason: undefined, closeResolution: undefined, windowStart: undefined, windowEnd: undefined, windowSource: undefined, windowPinPoint: undefined }));
    writeRoute({ ...now, stops: applyBookingWindows(repulled, "2026-11-07") });
    expect(getStop("TL-1")).toMatchObject({ windowEnd: "2026-11-07T15:00:00.000Z", windowPinPoint: true, photoIds: ["pod-tl-1"], signatureId: "sig-tl-1", closeReason: "Gate locked, left at the side door" });

    // The project's logistics are removed (an empty timeline): back to the start only, no end claimed.
    saveBookingTimelineWindows([{ bookingId: "TL-LATE", events: [] }], "2026-11-10");
    expect(syncStopWindowsFromBookings("2026-11-01")).toBe(1);
    expect(getStop("TL-1")).toMatchObject({ windowStart: "2026-11-07T14:00:00.000Z", photoIds: ["pod-tl-1"] });
    expect(getStop("TL-1")?.windowEnd).toBeUndefined();
    expect(getStop("TL-1")?.windowPinPoint).toBeUndefined();
  });
});

describe("POST /api/gs/projects { windows }", () => {
  it("stores the pulled timeline entries and refreshes stops already written", async () => {
    saveBookings([{ bookingId: "API-W1", eventName: "Api", eventDate: "2026-11-07", windowStartTime: "8:00 AM EST" }]);
    const routeId = "R-2026-11-07-E450-70002";
    writeRoute({ routeId, date: "2026-11-07", truckId: "E450", status: "ready", gsRouteId: "70002", stops: [stop(routeId, "API-1", 1, { txId: "API-W1", kind: "delivery" })] });
    const { POST } = await import("@/app/api/gs/projects/route");
    const res = await POST(
      new Request("http://localhost/api/gs/projects", {
        method: "POST",
        body: JSON.stringify({
          windows: [
            { bookingId: "API-W1", events: [{ marker: "DROP_OFF", name: "Delivery fee", dateLabel: "Saturday, 11/7 [8:00 AM - 10:00 AM]" }] },
            { bookingId: "API-FAILED" }, // no events[]: the fetch failed, nothing stored or cleared
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { windows: number; windowBookings: number; stopsUpdated: number };
    expect(j).toMatchObject({ windows: 1, windowBookings: 1 });
    expect(getStop("API-1")).toMatchObject({ windowStart: "2026-11-07T13:00:00.000Z", windowEnd: "2026-11-07T15:00:00.000Z" });
  });
});
