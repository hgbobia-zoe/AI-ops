import { describe, expect, it } from "vitest";
import { ymdInTz, todayInOpsTz } from "./dates";

describe("ymdInTz", () => {
  it("formats as YYYY-MM-DD", () => {
    expect(ymdInTz("America/New_York", new Date("2026-08-30T12:00:00Z"))).toBe("2026-08-30");
  });

  it("uses the target timezone's calendar day, not UTC", () => {
    // 01:30 UTC on Aug 31 is still 21:30 (Aug 30) in New York — the exact rollover
    // window that made an evening route import land under the wrong date.
    const instant = new Date("2026-08-31T01:30:00Z");
    expect(ymdInTz("UTC", instant)).toBe("2026-08-31");
    expect(ymdInTz("America/New_York", instant)).toBe("2026-08-30");
  });
});

describe("todayInOpsTz", () => {
  it("returns a valid YYYY-MM-DD string", () => {
    expect(todayInOpsTz()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("honors ETA_TIMEZONE when set", () => {
    const instant = new Date("2026-08-31T01:30:00Z");
    const prev = process.env.ETA_TIMEZONE;
    process.env.ETA_TIMEZONE = "America/New_York";
    try {
      expect(todayInOpsTz(instant)).toBe("2026-08-30");
    } finally {
      if (prev === undefined) delete process.env.ETA_TIMEZONE;
      else process.env.ETA_TIMEZONE = prev;
    }
  });
});
