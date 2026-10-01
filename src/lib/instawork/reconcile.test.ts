import { describe, it, expect } from "vitest";
import { instaworkCoversRole, instaworkLocalDate, instaworkShiftsForDate, summarizeInstaworkByRole } from "./reconcile";
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
    interestedPending: p.interestedPending ?? 0,
  };
}

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
