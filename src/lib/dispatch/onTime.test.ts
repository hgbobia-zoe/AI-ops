import { describe, expect, it } from "vitest";
import {
  ARRIVAL_MISMATCH_MIN,
  DEFAULT_ON_SITE_MIN,
  DEFAULT_TRANSIT_MIN,
  ON_TIME_GRACE_MIN,
  arrivalMismatch,
  bookingWindowForStop,
  estimateArrivals,
  formatDuration,
  parseGsWindowTime,
  scoreOnTime,
  stackingWarnings,
  unresolvedStops,
} from "./onTime";

describe("parseGsWindowTime (Goodshuffle logistics_start_from_time)", () => {
  it("reads the real searchProjects shape with an explicit zone", () => {
    // Palmer, Oct 30 2026: "9:00 AM EDT" → 13:00Z
    expect(parseGsWindowTime("2026-10-30", "9:00 AM EDT")).toBe("2026-10-30T13:00:00.000Z");
    // Wiener, Nov 1 2026 (after the DST change): "10:00 AM EST" → 15:00Z
    expect(parseGsWindowTime("2026-11-01", "10:00 AM EST")).toBe("2026-11-01T15:00:00.000Z");
    expect(parseGsWindowTime("2026-10-31", "12:00 PM EDT")).toBe("2026-10-31T16:00:00.000Z");
    expect(parseGsWindowTime("2026-10-31", "12:30 AM EDT")).toBe("2026-10-31T04:30:00.000Z");
  });

  it("reads a zone-less wall time in the operating timezone", () => {
    expect(parseGsWindowTime("2026-10-31", "9:00 AM")).toBe("2026-10-31T13:00:00.000Z");
    expect(parseGsWindowTime("2026-12-05", "13:30")).toBe("2026-12-05T18:30:00.000Z");
  });

  it("passes a full ISO datetime through", () => {
    expect(parseGsWindowTime(null, "2026-10-31T09:00:00.000-04:00")).toBe("2026-10-31T13:00:00.000Z");
  });

  it("returns null for TBD, blank, ambiguous or garbage", () => {
    expect(parseGsWindowTime("2026-10-31", "TBD")).toBeNull();
    expect(parseGsWindowTime("2026-10-31", "")).toBeNull();
    expect(parseGsWindowTime("2026-10-31", null)).toBeNull();
    expect(parseGsWindowTime("2026-10-31", "9")).toBeNull();
    expect(parseGsWindowTime("2026-10-31", "13:00 PM")).toBeNull();
    expect(parseGsWindowTime(null, "9:00 AM")).toBeNull();
  });
});

describe("bookingWindowForStop", () => {
  const base = { routeDate: "2026-10-31", eventDate: "2026-10-31", timeStr: "9:00 AM EDT" };
  it("applies the project window to a same-day delivery (or an unknown kind)", () => {
    expect(bookingWindowForStop({ ...base, kind: "delivery" })).toBe("2026-10-31T13:00:00.000Z");
    expect(bookingWindowForStop({ ...base, kind: undefined })).toBe("2026-10-31T13:00:00.000Z");
  });
  it("never applies the delivery window to a pickup or another day", () => {
    expect(bookingWindowForStop({ ...base, kind: "pickup" })).toBeNull();
    expect(bookingWindowForStop({ ...base, kind: "delivery", routeDate: "2026-11-01" })).toBeNull();
    expect(bookingWindowForStop({ ...base, kind: "delivery", eventDate: null })).toBeNull();
  });
});

describe("scoreOnTime", () => {
  const win = "2026-10-30T13:00:00.000Z"; // 9:00 AM ET

  it("Palmer: window 9:00, GPS arrival 10:37 → late by 97 min, GPS source", () => {
    const r = scoreOnTime({ windowStart: win, gpsArrivedAt: "2026-10-30T14:37:00.000Z", appArrivedAt: "2026-10-30T14:40:00.000Z" });
    expect(r).toMatchObject({ status: "late", source: "gps", minutesLate: 97 });
  });

  it("McGahn: window 9:00, arrival 1:44 PM → late by 284 min", () => {
    const r = scoreOnTime({ windowStart: "2026-10-31T13:00:00.000Z", gpsArrivedAt: "2026-10-31T17:44:00.000Z" });
    expect(r).toMatchObject({ status: "late", minutesLate: 284 });
  });

  it("uses the app tap when there is no GPS arrival", () => {
    const r = scoreOnTime({ windowStart: win, appArrivedAt: "2026-10-30T12:50:00.000Z" });
    expect(r).toMatchObject({ status: "on_time", source: "app", minutesLate: -10 });
  });

  it("grace is inclusive at the boundary", () => {
    const at = new Date(Date.parse(win) + ON_TIME_GRACE_MIN * 60_000).toISOString();
    const over = new Date(Date.parse(win) + (ON_TIME_GRACE_MIN + 1) * 60_000).toISOString();
    expect(scoreOnTime({ windowStart: win, appArrivedAt: at }).status).toBe("on_time");
    expect(scoreOnTime({ windowStart: win, appArrivedAt: over }).status).toBe("late");
  });

  it("is honest about missing data", () => {
    expect(scoreOnTime({ windowStart: win }).status).toBe("not_arrived");
    expect(scoreOnTime({ appArrivedAt: "2026-10-30T14:00:00.000Z" })).toMatchObject({ status: "no_window", source: "app" });
    expect(scoreOnTime({}).status).toBe("no_window");
  });
});

describe("arrivalMismatch", () => {
  it("Wiener: tap 11:09 AM, GPS 3:19 PM → flagged, GPS later by 250 min", () => {
    expect(arrivalMismatch("2026-11-01T16:09:00.000Z", "2026-11-01T20:19:00.000Z")).toEqual({ deltaMin: 250, gpsLater: true });
  });
  it("flags GPS earlier than the tap too", () => {
    expect(arrivalMismatch("2026-11-01T16:09:00.000Z", "2026-11-01T14:00:00.000Z")).toEqual({ deltaMin: -129, gpsLater: false });
  });
  it("does not flag within the threshold or with a side missing", () => {
    const tap = "2026-11-01T16:00:00.000Z";
    const within = new Date(Date.parse(tap) + ARRIVAL_MISMATCH_MIN * 60_000).toISOString();
    expect(arrivalMismatch(tap, within)).toBeNull();
    expect(arrivalMismatch(tap, null)).toBeNull();
    expect(arrivalMismatch(null, tap)).toBeNull();
  });
});

describe("stackingWarnings (pre-day sequencing)", () => {
  // The real Oct 31 2026 route 65573 as Goodshuffle planned it.
  const oct31 = [
    { stopId: "M", sequence: 1, custName: "Montealegre", kind: "delivery" as const, windowStart: "2026-10-31T13:00:00.000Z", plannedArrival: "2026-10-31T14:00:00.000Z", plannedOnSiteMin: 115, plannedTransitMin: 13 },
    { stopId: "G", sequence: 2, custName: "McGahn", kind: "delivery" as const, windowStart: "2026-10-31T13:00:00.000Z", plannedArrival: "2026-10-31T16:35:00.000Z", plannedOnSiteMin: 60, plannedTransitMin: 28 },
  ];

  it("warns that McGahn is stacked behind the long Montealegre install", () => {
    const w = stackingWarnings(oct31);
    expect(w).toHaveLength(1); // Montealegre is exactly 60 min past: not over the threshold
    expect(w[0]).toMatchObject({ stopId: "G", cause: "stacked", prevStopId: "M", prevOnSiteMin: 115, prevOnSiteDefaulted: false, minutesPastWindow: 215 });
    expect(w[0].message).toContain("McGahn");
    expect(w[0].message).toContain("3h 35m after the window opens");
    expect(w[0].message).toContain("Montealegre");
    expect(w[0].message).toContain("1h 55m on site");
    expect(w[0].message).not.toMatch(/[–—]/); // house style: no dashes
  });

  it("chains past an optimistic planned arrival", () => {
    // Planned arrival for stop 2 ignores how long stop 1 takes: the chain pushes it later.
    const est = estimateArrivals([
      { ...oct31[0], plannedOnSiteMin: 240 },
      { ...oct31[1], plannedArrival: "2026-10-31T14:30:00.000Z" },
    ]);
    // 14:00 + 240m + 28m = 18:28Z
    expect(new Date(est[1].estArrivalMs!).toISOString()).toBe("2026-10-31T18:28:00.000Z");
  });

  it("uses named defaults when Goodshuffle has no durations, and says so", () => {
    const w = stackingWarnings([
      { stopId: "A", sequence: 1, custName: "First", kind: "delivery", windowStart: "2026-10-31T13:00:00.000Z" },
      { stopId: "B", sequence: 2, custName: "Second", kind: "delivery", windowStart: "2026-10-31T12:00:00.000Z" },
    ]);
    // First arrives 13:00 (its window, no plan), departs +60 default, +30 default transit → 14:30Z; B window 12:00 → 150 min past.
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ stopId: "B", minutesPastWindow: DEFAULT_ON_SITE_MIN.delivery + DEFAULT_TRANSIT_MIN + 60, prevOnSiteDefaulted: true });
    expect(w[0].message).toContain("default, no duration in Goodshuffle");
  });

  it("flags a first stop that is itself planned well past its window", () => {
    // Palmer Oct 30: window 9:00, planned 11:05.
    const w = stackingWarnings([{ stopId: "P", sequence: 1, custName: "Palmer", windowStart: "2026-10-30T13:00:00.000Z", plannedArrival: "2026-10-30T15:05:00.000Z", plannedOnSiteMin: 50 }]);
    expect(w).toEqual([expect.objectContaining({ stopId: "P", cause: "planned_late", minutesPastWindow: 125 })]);
  });

  it("is silent without windows or when the plan fits", () => {
    expect(stackingWarnings([{ stopId: "A", sequence: 1, custName: "A", plannedArrival: "2026-10-31T13:00:00.000Z" }])).toEqual([]);
    expect(
      stackingWarnings([
        { stopId: "A", sequence: 1, custName: "A", windowStart: "2026-10-31T13:00:00.000Z", plannedArrival: "2026-10-31T13:00:00.000Z", plannedOnSiteMin: 30 },
        { stopId: "B", sequence: 2, custName: "B", windowStart: "2026-10-31T14:00:00.000Z", plannedTransitMin: 20, plannedOnSiteMin: 30 },
      ]),
    ).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("formats minutes plainly", () => {
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(120)).toBe("2h");
    expect(formatDuration(215)).toBe("3h 35m");
  });
});

describe("unresolvedStops (closeout gate)", () => {
  it("needs a real reason or a mark completed for every incomplete stop", () => {
    expect(unresolvedStops(["a", "b", "c"], [
      { stopId: "a", action: "completed" },
      { stopId: "b", action: "reason", reason: "  " },
      { stopId: "c", action: "reason", reason: "Customer not home, rescheduled" },
    ])).toEqual(["b"]);
    expect(unresolvedStops(["a"], undefined)).toEqual(["a"]);
    expect(unresolvedStops([], undefined)).toEqual([]);
  });
});
