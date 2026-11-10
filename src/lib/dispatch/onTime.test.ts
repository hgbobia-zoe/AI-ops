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
  formatWindow,
  onTimeBadge,
  parseGsWindowTime,
  parseTimelineDateLabel,
  parseTimelineWindows,
  pickTimelineWindow,
  resolveStopWindow,
  scoreOnTime,
  stackingWarnings,
  unresolvedStops,
  type RawTimelineEvent,
} from "./onTime";

// Real initProjectTimeline logisticsDelivery entries, verified live 2026-11-10.
const MCGAHN_EVENTS: RawTimelineEvent[] = [
  { marker: "DROP_OFF", name: "Delivery fee", dateLabel: "Saturday, 10/31 [9:00 AM - 8:00 PM]" },
  { marker: "PICK_UP", name: "Delivery fee", dateLabel: "Monday, 11/2 [9:00 AM - 7:15 PM]" },
];
const MONTEALEGRE_EVENTS: RawTimelineEvent[] = [
  { marker: "DROP_OFF", name: "PIN POINT EXACT TIME", dateLabel: "Saturday, 10/31 [9:00 AM - 10:00 AM]" },
  { marker: "DROP_OFF", name: "Event Readiness Service", dateLabel: "Saturday, 10/31 [10:15 AM]" },
  { marker: "PICK_UP", name: "PIN POINT EXACT TIME", dateLabel: "Monday, 11/2 [10:00 AM - 12:00 PM]" },
];

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

describe("parseTimelineDateLabel / parseTimelineWindows (initProjectTimeline)", () => {
  it("reads a range, in the operating timezone, with the year from the reference day", () => {
    expect(parseTimelineDateLabel("Saturday, 10/31 [9:00 AM - 8:00 PM]", "2026-10-31")).toEqual({
      date: "2026-10-31",
      startTime: "9:00 AM",
      endTime: "8:00 PM",
      startIso: "2026-10-31T13:00:00.000Z",
      endIso: "2026-11-01T00:00:00.000Z",
    });
    // After the DST change (EST): Monday 11/2 7:15 PM → 00:15Z next day.
    expect(parseTimelineDateLabel("Monday, 11/2 [9:00 AM - 7:15 PM]", "2026-10-31")).toMatchObject({
      date: "2026-11-02",
      startIso: "2026-11-02T14:00:00.000Z",
      endIso: "2026-11-03T00:15:00.000Z",
    });
  });

  it("a single time has start = end", () => {
    expect(parseTimelineDateLabel("Saturday, 10/31 [10:15 AM]", "2026-10-31")).toMatchObject({
      startTime: "10:15 AM",
      endTime: "10:15 AM",
      startIso: "2026-10-31T14:15:00.000Z",
      endIso: "2026-10-31T14:15:00.000Z",
    });
  });

  it("picks the nearest year across New Year and runs a range past midnight", () => {
    expect(parseTimelineDateLabel("Saturday, 1/2 [9:00 AM - 5:00 PM]", "2026-12-31")?.date).toBe("2027-01-02");
    expect(parseTimelineDateLabel("Thursday, 12/31 [9:00 AM]", "2027-01-02")?.date).toBe("2026-12-31");
    const late = parseTimelineDateLabel("Saturday, 10/31 [8:00 PM - 1:00 AM]", "2026-10-31");
    expect(late?.endIso).toBe("2026-11-01T05:00:00.000Z");
  });

  it("returns null for TBD or unreadable labels", () => {
    expect(parseTimelineDateLabel("Saturday, 10/31 [TBD]", "2026-10-31")).toBeNull();
    expect(parseTimelineDateLabel("Saturday, 10/31", "2026-10-31")).toBeNull();
    expect(parseTimelineDateLabel("", "2026-10-31")).toBeNull();
    expect(parseTimelineDateLabel("Monday, 2/30 [9:00 AM]", "2026-02-01")).toBeNull();
  });

  it("Montealegre: keeps both drop offs, flags the paid exact time, and picks it for the stop", () => {
    const w = parseTimelineWindows(MONTEALEGRE_EVENTS, "2026-10-31");
    expect(w.map((x) => [x.kind, x.date, x.startTime, x.endTime, x.pinPoint])).toEqual([
      ["drop_off", "2026-10-31", "9:00 AM", "10:00 AM", true],
      ["drop_off", "2026-10-31", "10:15 AM", "10:15 AM", false],
      ["pick_up", "2026-11-02", "10:00 AM", "12:00 PM", true],
    ]);
    expect(pickTimelineWindow(w.filter((x) => x.kind === "drop_off"))?.name).toBe("PIN POINT EXACT TIME");
  });

  it("a project with no logistics (customer pickup) has no windows; other event types are ignored", () => {
    expect(parseTimelineWindows([], "2026-10-31")).toEqual([]);
    expect(parseTimelineWindows([{ marker: "EVENT", name: "Wedding", dateLabel: "Saturday, 10/31 [5:00 PM]" }], "2026-10-31")).toEqual([]);
  });

  it("a range beats a single add on time when there is no exact time", () => {
    const w = parseTimelineWindows(
      [
        { marker: "DROP_OFF", name: "Event Readiness Service", dateLabel: "Saturday, 10/31 [8:15 AM]" },
        { marker: "DROP_OFF", name: "Delivery fee", dateLabel: "Saturday, 10/31 [9:00 AM - 8:00 PM]" },
      ],
      "2026-10-31",
    );
    expect(pickTimelineWindow(w)?.name).toBe("Delivery fee");
  });
});

describe("resolveStopWindow", () => {
  const mcgahn = parseTimelineWindows(MCGAHN_EVENTS, "2026-10-31");
  it("a delivery gets the DROP_OFF range, a pickup the PICK_UP range, each on its own day", () => {
    expect(resolveStopWindow({ kind: "delivery", routeDate: "2026-10-31", timeline: mcgahn })).toEqual({
      windowStart: "2026-10-31T13:00:00.000Z",
      windowEnd: "2026-11-01T00:00:00.000Z",
      pinPoint: false,
      label: "Delivery fee",
    });
    expect(resolveStopWindow({ kind: "pickup", routeDate: "2026-11-02", timeline: mcgahn })).toMatchObject({
      windowStart: "2026-11-02T14:00:00.000Z",
      windowEnd: "2026-11-03T00:15:00.000Z",
    });
    expect(resolveStopWindow({ kind: "pickup", routeDate: "2026-10-31", timeline: mcgahn })).toBeNull();
  });
  it("falls back to the start-only searchProjects time for a same-day delivery, with no end", () => {
    expect(resolveStopWindow({ kind: "delivery", routeDate: "2026-10-31", timeline: [], eventDate: "2026-10-31", timeStr: "9:00 AM EDT" })).toEqual({
      windowStart: "2026-10-31T13:00:00.000Z",
      pinPoint: false,
    });
  });
  it("formats windows without dashes", () => {
    expect(formatWindow("2026-10-31T13:00:00.000Z", "2026-11-01T00:00:00.000Z")).toBe("9:00 AM to 8:00 PM");
    expect(formatWindow("2026-10-31T14:15:00.000Z", "2026-10-31T14:15:00.000Z")).toBe("10:15 AM");
    expect(formatWindow("2026-10-31T13:00:00.000Z", null)).toBe("opens 9:00 AM, end unknown");
  });
});

describe("scoreOnTime", () => {
  const win = "2026-10-30T13:00:00.000Z"; // 9:00 AM ET

  it("McGahn Oct 31: window 9:00 AM to 8:00 PM, arrival 1:44 PM → ON TIME (PR #288 called it 4h 44m late)", () => {
    const r = scoreOnTime({ windowStart: "2026-10-31T13:00:00.000Z", windowEnd: "2026-11-01T00:00:00.000Z", gpsArrivedAt: "2026-10-31T17:44:00.000Z" });
    expect(r).toMatchObject({ status: "on_time", source: "gps", windowEndKnown: true, minutesLate: -376, minutesAfterStart: 284, early: false });
    expect(onTimeBadge(r)).toEqual({ label: "On time", tone: "positive" });
  });

  it("late minutes are measured from the window END, and a missed exact time is the most severe", () => {
    // Montealegre exact time 9:00 to 10:00 AM: 10:40 AM is 40 min past the end.
    const r = scoreOnTime({ windowStart: "2026-10-31T13:00:00.000Z", windowEnd: "2026-10-31T14:00:00.000Z", pinPoint: true, appArrivedAt: "2026-10-31T14:40:00.000Z" });
    expect(r).toMatchObject({ status: "late", minutesLate: 40, pinPoint: true, severity: "high" });
    expect(onTimeBadge(r)).toEqual({ label: "Missed exact time by 40m", tone: "critical" });
    const plain = scoreOnTime({ windowStart: "2026-11-07T13:00:00.000Z", windowEnd: "2026-11-07T15:00:00.000Z", appArrivedAt: "2026-11-07T15:40:00.000Z" });
    expect(plain).toMatchObject({ status: "late", minutesLate: 40, severity: "normal" });
    expect(onTimeBadge(plain)?.label).toBe("Late 40m");
  });

  it("arriving before the window opens is early: shown, still on time", () => {
    const r = scoreOnTime({ windowStart: "2026-11-07T13:00:00.000Z", windowEnd: "2026-11-07T15:00:00.000Z", appArrivedAt: "2026-11-07T12:35:00.000Z" });
    expect(r).toMatchObject({ status: "on_time", early: true, minutesEarly: 25 });
    expect(onTimeBadge(r)).toEqual({ label: "Early 25m", tone: "neutral" });
  });

  it("a single time window (start = end) allows the grace after it", () => {
    const t = "2026-10-31T14:15:00.000Z"; // 10:15 AM
    const at = new Date(Date.parse(t) + ON_TIME_GRACE_MIN * 60_000).toISOString();
    const over = new Date(Date.parse(t) + (ON_TIME_GRACE_MIN + 1) * 60_000).toISOString();
    expect(scoreOnTime({ windowStart: t, windowEnd: t, appArrivedAt: at }).status).toBe("on_time");
    expect(scoreOnTime({ windowStart: t, windowEnd: t, appArrivedAt: over })).toMatchObject({ status: "late", minutesLate: 16 });
  });

  it("start only (no end known): never claims late, says window end unknown", () => {
    // Palmer Oct 30 with only the searchProjects start: arrival 10:37 AM.
    const r = scoreOnTime({ windowStart: win, gpsArrivedAt: "2026-10-30T14:37:00.000Z", appArrivedAt: "2026-10-30T14:40:00.000Z" });
    expect(r).toMatchObject({ status: "window_end_unknown", source: "gps", windowEndKnown: false, minutesAfterStart: 97 });
    expect(r.minutesLate).toBeUndefined();
    expect(onTimeBadge(r)).toEqual({ label: "Window end unknown", tone: "neutral" });
    // Within start + grace it is on time for certain (the end can only be later).
    expect(scoreOnTime({ windowStart: win, appArrivedAt: "2026-10-30T13:10:00.000Z" })).toMatchObject({ status: "on_time", windowEndKnown: false });
  });

  it("uses the app tap when there is no GPS arrival", () => {
    const r = scoreOnTime({ windowStart: win, windowEnd: "2026-10-30T15:00:00.000Z", appArrivedAt: "2026-10-30T12:50:00.000Z" });
    expect(r).toMatchObject({ status: "on_time", source: "app", early: true, minutesEarly: 10 });
  });

  it("grace is inclusive at the boundary of the window end", () => {
    const end = "2026-10-30T15:00:00.000Z";
    const at = new Date(Date.parse(end) + ON_TIME_GRACE_MIN * 60_000).toISOString();
    const over = new Date(Date.parse(end) + (ON_TIME_GRACE_MIN + 1) * 60_000).toISOString();
    expect(scoreOnTime({ windowStart: win, windowEnd: end, appArrivedAt: at }).status).toBe("on_time");
    expect(scoreOnTime({ windowStart: win, windowEnd: end, appArrivedAt: over }).status).toBe("late");
  });

  it("is honest about missing data", () => {
    expect(scoreOnTime({ windowStart: win }).status).toBe("not_arrived");
    expect(scoreOnTime({ appArrivedAt: "2026-10-30T14:00:00.000Z" })).toMatchObject({ status: "no_window", source: "app" });
    expect(scoreOnTime({}).status).toBe("no_window");
  });

  it("keeps the PR #288 result fields (status, arrivalIso, source, minutesLate) for existing consumers", () => {
    const r = scoreOnTime({ windowStart: win, windowEnd: "2026-10-30T15:00:00.000Z", appArrivedAt: "2026-10-30T15:30:00.000Z" });
    expect(r).toMatchObject({ status: "late", arrivalIso: "2026-10-30T15:30:00.000Z", source: "app", minutesLate: 30 });
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
  // The real Oct 31 2026 route 65573 as Goodshuffle planned it, with the real timeline windows.
  const oct31 = [
    { stopId: "M", sequence: 1, custName: "Montealegre", kind: "delivery" as const, windowStart: "2026-10-31T13:00:00.000Z", windowEnd: "2026-10-31T14:00:00.000Z", pinPoint: true, plannedArrival: "2026-10-31T14:00:00.000Z", plannedOnSiteMin: 115, plannedTransitMin: 13 },
    { stopId: "G", sequence: 2, custName: "McGahn", kind: "delivery" as const, windowStart: "2026-10-31T13:00:00.000Z", windowEnd: "2026-11-01T00:00:00.000Z", plannedArrival: "2026-10-31T16:35:00.000Z", plannedOnSiteMin: 60, plannedTransitMin: 28 },
  ];

  it("the real Oct 31 plan fits its windows: McGahn's runs to 8:00 PM, Montealegre lands at its exact time end", () => {
    expect(stackingWarnings(oct31)).toEqual([]);
  });

  it("warns against the window END: a stop planned after its window closes, behind a long stop", () => {
    const w = stackingWarnings([oct31[0], { ...oct31[1], windowEnd: "2026-10-31T15:00:00.000Z" }]); // McGahn window 9 to 11 AM
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ stopId: "G", cause: "stacked", windowEndKnown: true, minutesPastWindow: 95, prevStopId: "M", prevOnSiteMin: 115 });
    expect(w[0].message).toContain("1h 35m after the window closes at 11:00 AM");
    expect(w[0].message).toContain("Montealegre");
    expect(w[0].message).toContain("1h 55m on site");
    expect(w[0].message).not.toMatch(/[–—-]/); // house style: no dashes
  });

  it("names an exact time window when one would be missed", () => {
    const w = stackingWarnings([{ ...oct31[0], plannedArrival: "2026-10-31T14:40:00.000Z" }]);
    expect(w).toEqual([expect.objectContaining({ stopId: "M", cause: "planned_late", pinPoint: true, minutesPastWindow: 40 })]);
    expect(w[0].message).toContain("after the exact time window closes at 10:00 AM");
  });

  it("start only: the old 60 minute check, labelled window end unknown", () => {
    const startOnly = oct31.map((s) => ({ ...s, windowEnd: undefined, pinPoint: false }));
    const w = stackingWarnings(startOnly);
    expect(w).toHaveLength(1); // Montealegre is exactly 60 min past the start: not over the threshold
    expect(w[0]).toMatchObject({ stopId: "G", cause: "stacked", windowEndKnown: false, minutesPastWindow: 215 });
    expect(w[0].message).toContain("3h 35m after the window opens");
    expect(w[0].message).toContain("Window end unknown.");
    expect(w[0].message).not.toMatch(/[–—-]/);
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

  it("flags a first stop that is itself planned well past its window start (start only)", () => {
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
