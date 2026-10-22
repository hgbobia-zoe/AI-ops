import { describe, it, expect } from "vitest";
import {
  isWithinBusinessHours,
  nextOpenAt,
  nextOpenLabel,
  parseHM,
  sanitizeSchedule,
  DEFAULT_BUSINESS_HOURS,
  type BusinessHoursSchedule,
} from "./businessHours";

// All instants are expressed in UTC (Z). The ops timezone is America/New_York; January is EST (UTC-5),
// July is EDT (UTC-4). Jan 1 2026 is a Thursday, so Jan 2 = Fri, 3 = Sat, 4 = Sun, 5 = Mon.
const at = (iso: string): Date => new Date(iso);

describe("isWithinBusinessHours — default schedule (ops TZ)", () => {
  it("is OPEN mid-afternoon on a weekday (Mon 2:00 PM ET)", () => {
    expect(isWithinBusinessHours(at("2026-01-05T19:00:00Z"))).toBe(true);
  });

  it("is CLOSED one minute after the weekday close (Fri 6:01 PM ET)", () => {
    expect(isWithinBusinessHours(at("2026-01-02T23:01:00Z"))).toBe(false);
  });

  it("is OPEN at the Saturday half-day's last open minute (12:59 PM ET)", () => {
    expect(isWithinBusinessHours(at("2026-01-03T17:59:00Z"))).toBe(true);
  });

  it("is CLOSED just after the Saturday half-day close (1:01 PM ET)", () => {
    expect(isWithinBusinessHours(at("2026-01-03T18:01:00Z"))).toBe(false);
  });

  it("is CLOSED all day Sunday", () => {
    expect(isWithinBusinessHours(at("2026-01-04T16:00:00Z"))).toBe(false); // Sun 11:00 AM ET
    expect(isWithinBusinessHours(at("2026-01-04T20:00:00Z"))).toBe(false); // Sun 3:00 PM ET
  });

  it("is CLOSED before the 10:00 AM open (Mon 9:59 AM ET)", () => {
    expect(isWithinBusinessHours(at("2026-01-05T14:59:00Z"))).toBe(false);
  });

  it("is OPEN exactly at the open minute, CLOSED exactly at the close minute (inclusive/exclusive)", () => {
    expect(isWithinBusinessHours(at("2026-01-05T15:00:00Z"))).toBe(true); // Mon 10:00 AM ET (inclusive)
    expect(isWithinBusinessHours(at("2026-01-05T23:00:00Z"))).toBe(false); // Mon 6:00 PM ET (exclusive)
  });
});

describe("isWithinBusinessHours — ops-TZ correctness", () => {
  it("reads the clock in ET, not UTC (Sat 12:00 PM ET = 17:00 UTC is OPEN, though 17:00 would be closed)", () => {
    // A naive UTC implementation would treat this as Saturday 17:00 (past the 13:00 close) and return false.
    expect(isWithinBusinessHours(at("2026-01-03T17:00:00Z"))).toBe(true);
  });

  it("handles DST: Sat 12:00 PM EDT = 16:00 UTC is OPEN, 1:30 PM EDT is closed", () => {
    expect(isWithinBusinessHours(at("2026-07-04T16:00:00Z"))).toBe(true); // Sat noon EDT (Jul 4 2026 is a Sat)
    expect(isWithinBusinessHours(at("2026-07-04T17:30:00Z"))).toBe(false); // Sat 1:30 PM EDT
  });

  it("computes the WEEKDAY in ET across a UTC-day-vs-ET-day boundary", () => {
    // 2026-01-04T02:30:00Z is Sunday in UTC but Saturday 9:30 PM in ET. With an override opening Saturday
    // late, it must read as Saturday (open) — a UTC-day implementation would see Sunday (closed).
    const override: BusinessHoursSchedule = { "6": { open: "20:00", close: "23:00" } };
    expect(isWithinBusinessHours(at("2026-01-04T02:30:00Z"), override)).toBe(true);
    // Same instant with the default schedule is closed (Saturday 21:30 is past the 13:00 close).
    expect(isWithinBusinessHours(at("2026-01-04T02:30:00Z"))).toBe(false);
  });
});

describe("isWithinBusinessHours — admin overrides", () => {
  it("respects an override that opens Sunday", () => {
    const override: BusinessHoursSchedule = { "0": { open: "09:00", close: "17:00" } };
    expect(isWithinBusinessHours(at("2026-01-04T16:00:00Z"), override)).toBe(true); // Sun 11:00 AM ET
  });

  it("respects an override that extends a weekday earlier", () => {
    const override: BusinessHoursSchedule = { "1": { open: "08:00", close: "20:00" } };
    expect(isWithinBusinessHours(at("2026-01-05T14:59:00Z"), override)).toBe(true); // Mon 9:59 AM ET now open
  });

  it("respects an override that closes a day (explicit null)", () => {
    const override: BusinessHoursSchedule = { "6": null };
    expect(isWithinBusinessHours(at("2026-01-03T17:00:00Z"), override)).toBe(false); // Sat now closed
  });
});

describe("isWithinBusinessHours — bad/empty config falls back to the default", () => {
  it("falls back per-weekday on a garbage entry", () => {
    // A garbage Monday entry degrades to the default Monday (10-18), so Mon 2 PM is still open.
    const bad = { "1": { open: "nonsense", close: "???" } } as unknown as BusinessHoursSchedule;
    expect(isWithinBusinessHours(at("2026-01-05T19:00:00Z"), bad)).toBe(true);
  });

  it("falls back to the full default on a non-object schedule", () => {
    const bad = "not a schedule" as unknown as BusinessHoursSchedule;
    expect(isWithinBusinessHours(at("2026-01-05T19:00:00Z"), bad)).toBe(true); // Mon 2 PM open
    expect(isWithinBusinessHours(at("2026-01-04T16:00:00Z"), bad)).toBe(false); // Sun closed
  });

  it("falls back to the default when no schedule is passed at all", () => {
    expect(isWithinBusinessHours(at("2026-01-05T19:00:00Z"))).toBe(true);
  });
});

describe("parseHM", () => {
  it("parses valid HH:MM to minutes since midnight", () => {
    expect(parseHM("10:00")).toBe(600);
    expect(parseHM("18:30")).toBe(1110);
    expect(parseHM("00:00")).toBe(0);
  });
  it("rejects malformed values", () => {
    expect(parseHM("nonsense")).toBeNull();
    expect(parseHM("25:00")).toBeNull();
    expect(parseHM("10:99")).toBeNull();
    expect(parseHM("")).toBeNull();
    expect(parseHM(123 as unknown as string)).toBeNull();
  });
});

describe("sanitizeSchedule", () => {
  it("returns a full 0-6 schedule equal to the default for an empty object", () => {
    const s = sanitizeSchedule({});
    expect(s).toEqual(DEFAULT_BUSINESS_HOURS);
  });
  it("preserves an explicit null (closed) and a valid override", () => {
    const s = sanitizeSchedule({ "0": { open: "09:00", close: "12:00" }, "6": null });
    expect(s["0"]).toEqual({ open: "09:00", close: "12:00" });
    expect(s["6"]).toBeNull();
    expect(s["1"]).toEqual(DEFAULT_BUSINESS_HOURS["1"]); // untouched day keeps the default
  });
  it("drops an inverted window (open >= close) back to the default", () => {
    const s = sanitizeSchedule({ "1": { open: "18:00", close: "10:00" } });
    expect(s["1"]).toEqual(DEFAULT_BUSINESS_HOURS["1"]);
  });
});

describe("nextOpenAt / nextOpenLabel", () => {
  it("returns the next Monday open for a closed Sunday", () => {
    const next = nextOpenAt(at("2026-01-04T16:00:00Z")); // Sunday
    expect(next?.toISOString()).toBe("2026-01-05T15:00:00.000Z"); // Mon 10:00 AM EST = 15:00 UTC
  });
  it("returns `now` when already open", () => {
    const now = at("2026-01-05T19:00:00Z");
    expect(nextOpenAt(now)?.getTime()).toBe(now.getTime());
  });
  it("labels the next open time in ET", () => {
    expect(nextOpenLabel(at("2026-01-04T16:00:00Z"))).toBe("Mon 10:00 AM ET");
  });
});
