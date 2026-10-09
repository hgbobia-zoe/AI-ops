import { describe, it, expect } from "vitest";
import {
  instaworkCoversRole,
  instaworkLocalDate,
  instaworkShiftsForDate,
  summarizeInstaworkByRole,
  gigOverlapsWindow,
  instaworkGigsForRoute,
  findGigForWorker,
} from "./reconcile";
import type { InstaworkShift } from "./types";

function shift(p: Partial<InstaworkShift>): InstaworkShift {
  return {
    id: p.id ?? "g1",
    name: p.name ?? "ZER",
    // 2026-10-03T06:00:00-07:00 = 2026-10-03 09:00 America/New_York
    startsAt: p.startsAt ?? "2026-10-03T06:00:00-07:00",
    endsAt: p.endsAt ?? "2026-10-03T14:30:00-07:00",
    timezone: p.timezone ?? "America/New_York",
    position: p.position ?? "Driver",
    basePrice: p.basePrice ?? 40.98,
    filled: p.filled ?? 1,
    total: p.total ?? 1,
    locationName: p.locationName ?? "ZER",
    workers: p.workers ?? [],
    workerIds: p.workerIds ?? [],
    interestedPending: p.interestedPending ?? 0,
    clockInCode: p.clockInCode ?? null,
    clockOutCode: p.clockOutCode ?? null,
  };
}

describe("findGigForWorker", () => {
  const day = "2026-10-03"; // the local start-day of the default shift()
  it("matches by worker id (preferred) and returns that gig's codes", () => {
    const g = shift({ id: "g9", workerIds: ["55"], workers: ["Alex P"], clockInCode: "3243", clockOutCode: "2450" });
    const hit = findGigForWorker([g], day, { workerId: "55" });
    expect(hit?.clockInCode).toBe("3243");
    expect(hit?.clockOutCode).toBe("2450");
  });
  it("falls back to a case-insensitive name match", () => {
    const g = shift({ id: "g9", workers: ["Alex P"] });
    expect(findGigForWorker([g], day, { workerName: "alex p" })?.id).toBe("g9");
  });
  it("returns null when the worker is not on any gig that day", () => {
    const g = shift({ id: "g9", workers: ["Someone Else"] });
    expect(findGigForWorker([g], day, { workerName: "Alex P" })).toBeNull();
    expect(findGigForWorker([g], "2026-10-04", { workerName: "Someone Else" })).toBeNull();
  });
});

describe("instaworkCoversRole", () => {
  it("Driver covers only the driver role", () => {
    expect(instaworkCoversRole("Driver", "driver")).toBe(true);
    expect(instaworkCoversRole("Driver", "field")).toBe(false);
    expect(instaworkCoversRole("Driver", "prep")).toBe(false);
  });
  it("General Labor covers field and prep, not driver", () => {
    expect(instaworkCoversRole("General Labor", "field")).toBe(true);
    expect(instaworkCoversRole("General Labor", "prep")).toBe(true);
    expect(instaworkCoversRole("General Labor", "driver")).toBe(false);
  });
  it("an unknown position covers nothing", () => {
    expect(instaworkCoversRole("Bartender", "field")).toBe(false);
  });
});

describe("instaworkLocalDate", () => {
  it("resolves to the local day in the shift's timezone", () => {
    expect(instaworkLocalDate(shift({}))).toBe("2026-10-03");
    // A late-night gig that crosses midnight UTC still reports its ET start day.
    expect(instaworkLocalDate(shift({ startsAt: "2026-10-03T19:30:00-07:00" }))).toBe("2026-10-03");
  });
});

describe("instaworkShiftsForDate", () => {
  it("keeps only shifts on the given local day", () => {
    const list = [shift({ id: "a" }), shift({ id: "b", startsAt: "2026-10-04T06:00:00-07:00", endsAt: "2026-10-04T10:00:00-07:00" })];
    expect(instaworkShiftsForDate(list, "2026-10-03").map((s) => s.id)).toEqual(["a"]);
  });
});

describe("summarizeInstaworkByRole", () => {
  it("tallies booked/pending/total per role for the day", () => {
    const list = [
      shift({ position: "Driver", filled: 1, total: 1 }), // driver booked
      shift({ position: "Driver", filled: 0, total: 1 }), // driver pending (the real unfilled Oct 3 Driver)
      shift({ position: "General Labor", filled: 1, total: 1 }), // covers field + prep
    ];
    const s = summarizeInstaworkByRole(list, "2026-10-03");
    expect(s.driver).toEqual({ total: 2, booked: 1, pending: 1 });
    // General Labor counts toward BOTH field and prep (availability view).
    expect(s.field).toEqual({ total: 1, booked: 1, pending: 0 });
    expect(s.prep).toEqual({ total: 1, booked: 1, pending: 0 });
  });
  it("ignores shifts on other days", () => {
    const list = [shift({ position: "Driver", startsAt: "2026-10-05T06:00:00-07:00", endsAt: "2026-10-05T10:00:00-07:00" })];
    expect(summarizeInstaworkByRole(list, "2026-10-03").driver).toEqual({ total: 0, booked: 0, pending: 0 });
  });
});

describe("gigOverlapsWindow", () => {
  // The default fixture runs 2026-10-03 09:00–17:30 ET.
  const g = shift({});
  const et = (iso: string): number => Date.parse(iso);
  it("overlapping windows match", () => {
    expect(gigOverlapsWindow(g, et("2026-10-03T13:00:00-04:00"), et("2026-10-03T20:00:00-04:00"))).toBe(true);
  });
  it("disjoint windows do not match", () => {
    // Route 06:00–08:00 ET, before the 09:00 gig start.
    expect(gigOverlapsWindow(g, et("2026-10-03T06:00:00-04:00"), et("2026-10-03T08:00:00-04:00"))).toBe(false);
  });
  it("an unknown route window never excludes (falls back to day + role)", () => {
    expect(gigOverlapsWindow(g, null, null)).toBe(true);
    expect(gigOverlapsWindow(g, et("2026-10-03T06:00:00-04:00"), null)).toBe(true);
  });
});

describe("instaworkGigsForRoute", () => {
  const driverGig = shift({ id: "drv", position: "Driver" });
  const laborGig = shift({ id: "lab", position: "General Labor" });
  const otherDay = shift({ id: "x", position: "Driver", startsAt: "2026-10-04T06:00:00-07:00", endsAt: "2026-10-04T10:00:00-07:00" });
  const gigs = [driverGig, laborGig, otherDay];
  const et = (iso: string): number => Date.parse(iso);

  it("matches by day + position→role + time overlap", () => {
    const got = instaworkGigsForRoute(gigs, {
      date: "2026-10-03",
      startMs: et("2026-10-03T08:00:00-04:00"),
      endMs: et("2026-10-03T18:00:00-04:00"),
      roles: ["driver", "field"],
    });
    expect(got.map((g) => g.id).sort()).toEqual(["drv", "lab"]);
  });

  it("filters by role — a driver-only route ignores a General Labor gig", () => {
    const got = instaworkGigsForRoute(gigs, {
      date: "2026-10-03",
      startMs: et("2026-10-03T08:00:00-04:00"),
      endMs: et("2026-10-03T18:00:00-04:00"),
      roles: ["driver"],
    });
    expect(got.map((g) => g.id)).toEqual(["drv"]);
  });

  it("excludes gigs on other days", () => {
    const got = instaworkGigsForRoute(gigs, {
      date: "2026-10-04",
      startMs: et("2026-10-04T05:00:00-04:00"),
      endMs: et("2026-10-04T12:00:00-04:00"),
      roles: ["driver"],
    });
    expect(got.map((g) => g.id)).toEqual(["x"]);
  });

  it("excludes gigs outside the route window", () => {
    const got = instaworkGigsForRoute(gigs, {
      date: "2026-10-03",
      startMs: et("2026-10-03T05:00:00-04:00"),
      endMs: et("2026-10-03T08:00:00-04:00"), // ends before the 09:00 gig start
      roles: ["driver", "field"],
    });
    expect(got).toEqual([]);
  });

  it("an unknown route window matches on day + role alone", () => {
    const got = instaworkGigsForRoute(gigs, {
      date: "2026-10-03",
      startMs: null,
      endMs: null,
      roles: ["driver", "field"],
    });
    expect(got.map((g) => g.id).sort()).toEqual(["drv", "lab"]);
  });

  it("the same gig can match multiple routes (availability, not allocation)", () => {
    const routeA = instaworkGigsForRoute(gigs, { date: "2026-10-03", startMs: et("2026-10-03T08:00:00-04:00"), endMs: et("2026-10-03T13:00:00-04:00"), roles: ["driver"] });
    const routeB = instaworkGigsForRoute(gigs, { date: "2026-10-03", startMs: et("2026-10-03T12:00:00-04:00"), endMs: et("2026-10-03T18:00:00-04:00"), roles: ["driver"] });
    expect(routeA.map((g) => g.id)).toEqual(["drv"]);
    expect(routeB.map((g) => g.id)).toEqual(["drv"]);
  });
});
