import { describe, expect, it } from "vitest";
import { ymdInTz, todayInOpsTz, formatClockTime, isoToOpsLocalInput, opsLocalInputToIso } from "./dates";

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

// A Connecteam shift's start/end are absolute Unix seconds. The app must render AND round-trip them in the
// OPERATING timezone (America/New_York), never the host/browser tz. Regression for the "11:00 PM shows as
// 5:30 AM" offset bug: a conversion that used the device tz instead of ET.
describe("shift times are anchored to America/New_York, not the host tz", () => {
  // 11:00 PM ET on 2026-10-16 (EDT, UTC-4) and 3:00 AM ET on 2026-10-17 — the reported test shift.
  const start = "2026-10-17T03:00:00.000Z"; // = 11:00 PM ET, 10/16
  const end = "2026-10-17T07:00:00.000Z"; //   = 3:00 AM ET, 10/17

  it("displays an 11:00 PM – 3:00 AM ET Connecteam shift as 11:00 PM – 3:00 AM (not 5:30 AM – 9:30 AM)", () => {
    expect(formatClockTime(start)).toBe("11:00 PM");
    expect(formatClockTime(end)).toBe("3:00 AM");
  });

  it("isoToOpsLocalInput renders the datetime-local value in ET wall-clock", () => {
    expect(isoToOpsLocalInput(start)).toBe("2026-10-16T23:00");
    expect(isoToOpsLocalInput(end)).toBe("2026-10-17T03:00");
    expect(isoToOpsLocalInput(null)).toBe("");
  });

  it("opsLocalInputToIso interprets the wall time in ET and round-trips the absolute instant", () => {
    expect(opsLocalInputToIso("2026-10-16T23:00")).toBe(start);
    expect(opsLocalInputToIso("2026-10-17T03:00")).toBe(end);
    expect(opsLocalInputToIso("")).toBeNull();
    // Round-trip: ET wall-clock → ISO → ET wall-clock is stable.
    expect(isoToOpsLocalInput(opsLocalInputToIso("2026-10-16T23:00"))).toBe("2026-10-16T23:00");
  });
});
