import { describe, expect, it } from "vitest";
import { unavailabilityLabel, unavailabilityWindow } from "./unavailabilityLabel";
import { eligibilityView } from "./eligibilityLabel";
import { eligibilityFor } from "./eligibility";

// Real Connecteam blocks from the week of Nov 16 2026 (EST, UTC-5), read off /scheduling and checked
// against the Connecteam scheduler: a driver unavailable 3:00 to 9:00 PM on Nov 17, another with time off
// 2:30 to 3:30 PM, and Connecteam's all day block (12:00 AM to 11:59 PM).
const u = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const TZ = "America/New_York";

describe("unavailability reads in Eastern time with its hours", () => {
  it("a block inside the day shows its hours", () => {
    expect(unavailabilityLabel({ kind: "unavailability", startUnix: u("2026-11-17T20:00:00Z"), endUnix: u("2026-11-18T02:00:00Z") }, { tz: TZ }))
      .toBe("Unavailable 3:00 PM to 9:00 PM");
    expect(unavailabilityLabel({ kind: "timeOff", startUnix: u("2026-11-17T19:30:00Z"), endUnix: u("2026-11-17T20:30:00Z"), reason: "Court for son" }, { tz: TZ }))
      .toBe("Time off 2:30 PM to 3:30 PM (Court for son)");
  });

  it("from midnight reads as until, to the end of the day reads as after", () => {
    expect(unavailabilityLabel({ kind: "unavailability", startUnix: u("2026-11-17T05:00:00Z"), endUnix: u("2026-11-17T19:00:00Z") }, { tz: TZ }))
      .toBe("Unavailable until 2:00 PM");
    expect(unavailabilityLabel({ kind: "unavailability", startUnix: u("2026-11-17T20:00:00Z"), endUnix: u("2026-11-18T04:59:00Z") }, { tz: TZ }))
      .toBe("Unavailable after 3:00 PM");
  });

  it("Connecteam's 12:00 AM to 11:59 PM block is all day, and a multi day block is all day on the days it covers", () => {
    expect(unavailabilityWindow({ kind: "unavailability", startUnix: u("2026-11-14T05:00:00Z"), endUnix: u("2026-11-15T04:59:00Z") }, { tz: TZ })).toBe("all day");
    const trip = { kind: "timeOff" as const, startUnix: u("2026-11-20T05:00:00Z"), endUnix: u("2026-11-23T04:59:00Z") };
    expect(unavailabilityWindow(trip, { day: "2026-11-21", tz: TZ })).toBe("all day");
    // Seen from the day it ends, a block that started the day before is "until".
    expect(unavailabilityWindow({ kind: "timeOff", startUnix: u("2026-11-20T23:00:00Z"), endUnix: u("2026-11-21T17:00:00Z") }, { day: "2026-11-21", tz: TZ })).toBe("until 12:00 PM");
  });
});

describe("the worker pickers say when, and only block a shift the hours overlap", () => {
  const block = { userId: 7, kind: "unavailability" as const, startUnix: u("2026-11-17T05:00:00Z"), endUnix: u("2026-11-17T19:00:00Z") }; // until 2:00 PM
  const run = (start: string, end: string) =>
    eligibilityFor({ userId: 7, routeWindow: { start: u(start), end: u(end) }, dayShifts: [], assignments: [], unavailability: [block], availabilityKnown: true });

  it("a morning route is blocked, and the label and badge carry the hours", () => {
    const r = run("2026-11-17T14:00:00Z", "2026-11-17T18:00:00Z"); // 9:00 AM to 1:00 PM
    expect(r.state).toBe("UNAVAILABLE");
    expect(r.reasons.join(" ")).toContain("until 2:00 PM");
    const v = eligibilityView(r, TZ);
    expect(v.text).toBe("Unavailable until 2:00 PM");
    expect(v.badge).toBe("unavailable until 2:00 PM");
  });

  it("an afternoon route after the block is free (unavailable only where it overlaps)", () => {
    const r = run("2026-11-17T19:30:00Z", "2026-11-17T23:00:00Z"); // 2:30 PM to 6:00 PM
    expect(r.state).toBe("AVAILABLE");
    expect(eligibilityView(r, TZ).badge).toBe("available");
  });
});
