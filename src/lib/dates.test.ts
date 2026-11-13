import { describe, expect, it } from "vitest";
import {
  ymdInTz,
  todayInOpsTz,
  formatClockTime,
  isoToOpsLocalInput,
  opsLocalInputToIso,
  currentOperatingYearStart,
  isBusinessDay,
  businessDaysUntil,
  isWithinBusinessDays,
  opsMinutesIntoDay,
  opsOffsetMinutes,
  opsWallTimeToMs,
  opsYmdOfMs,
  tzOffsetMinutes as tzOff,
} from "./dates";

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

describe("currentOperatingYearStart", () => {
  it("returns Jan 1 of the current calendar year in the operating timezone (dynamic, not hardcoded)", () => {
    const prev = process.env.ETA_TIMEZONE;
    process.env.ETA_TIMEZONE = "America/New_York";
    try {
      // Late-night UTC that is still the PREVIOUS year in ET — the year must follow ET, not UTC.
      expect(currentOperatingYearStart(new Date("2027-01-01T02:00:00Z"))).toBe("2026-01-01");
      expect(currentOperatingYearStart(new Date("2026-06-15T12:00:00Z"))).toBe("2026-01-01");
      expect(currentOperatingYearStart(new Date("2028-06-15T12:00:00Z"))).toBe("2028-01-01");
    } finally {
      if (prev === undefined) delete process.env.ETA_TIMEZONE;
      else process.env.ETA_TIMEZONE = prev;
    }
  });

  it("honors a settings override (bare year or full date), ignoring a malformed one", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    expect(currentOperatingYearStart(now, "2025")).toBe("2025-01-01"); // bare year
    expect(currentOperatingYearStart(now, "2024-03-01")).toBe("2024-03-01"); // full date
    expect(currentOperatingYearStart(now, "  2023  ")).toBe("2023-01-01"); // trimmed
    expect(currentOperatingYearStart(now, "garbage")).toBe("2026-01-01"); // falls back to computed
    expect(currentOperatingYearStart(now, null)).toBe("2026-01-01");
    expect(currentOperatingYearStart(now, "")).toBe("2026-01-01");
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

// Business-day math for the e-signature cutoff. Anchored to a known Monday (2026-10-19) in ET.
describe("business-day helpers", () => {
  const mon = new Date("2026-10-19T15:00:00Z"); // 11:00 AM ET on Mon 2026-10-19 → todayInOpsTz = 2026-10-19
  const fri = new Date("2026-10-16T15:00:00Z"); // 11:00 AM ET on Fri 2026-10-16

  it("isBusinessDay flags Mon–Fri, not the weekend", () => {
    expect(isBusinessDay("2026-10-16")).toBe(true); // Fri
    expect(isBusinessDay("2026-10-17")).toBe(false); // Sat
    expect(isBusinessDay("2026-10-18")).toBe(false); // Sun
    expect(isBusinessDay("2026-10-19")).toBe(true); // Mon
    expect(isBusinessDay("nonsense")).toBe(false);
  });

  it("businessDaysUntil counts weekdays, excludes weekends, today = 0, past = negative", () => {
    expect(businessDaysUntil("2026-10-19", mon)).toBe(0); // today
    expect(businessDaysUntil("2026-10-20", mon)).toBe(1); // Tue
    expect(businessDaysUntil("2026-10-22", mon)).toBe(3); // Thu — the exact 3-day boundary
    expect(businessDaysUntil("2026-10-23", mon)).toBe(4); // Fri
    expect(businessDaysUntil("2026-10-26", mon)).toBe(5); // next Mon (Sat/Sun skipped), not 7
    expect(businessDaysUntil("2026-10-16", mon)).toBe(-1); // last Fri, in the past
    expect(businessDaysUntil("bad-date", mon)).toBeNaN();
  });

  it("businessDaysUntil skips the weekend when counting across it", () => {
    // From Fri, Wed is 3 business days away (Mon, Tue, Wed) — Sat/Sun don't count.
    expect(businessDaysUntil("2026-10-21", fri)).toBe(3);
    expect(businessDaysUntil("2026-10-19", fri)).toBe(1); // next Mon
  });

  it("isWithinBusinessDays(…, 3) selects 3-days-out, rejects 5-days-out and the past", () => {
    expect(isWithinBusinessDays("2026-10-19", 3, mon)).toBe(true); //  today
    expect(isWithinBusinessDays("2026-10-22", 3, mon)).toBe(true); //  exactly 3 biz days
    expect(isWithinBusinessDays("2026-10-23", 3, mon)).toBe(false); // 4 biz days
    expect(isWithinBusinessDays("2026-10-26", 3, mon)).toBe(false); // 5 biz days out
    expect(isWithinBusinessDays("2026-10-16", 3, mon)).toBe(false); // in the past
  });
});

// ── The shared Eastern time helper, on BOTH sides of the DST switch ─────────────────────────────────────
// 2026: EDT (UTC-4) until Sun Nov 1 2:00 AM, then EST (UTC-5). Spring forward was Sun Mar 8.

describe("Eastern time helper across DST", () => {
  const NY = "America/New_York";

  it("knows the real offset: -240 in EDT, -300 in EST (never a fixed -04:00)", () => {
    expect(opsOffsetMinutes(Date.UTC(2026, 9, 31, 16, 0), NY)).toBe(-240); // Oct 31, EDT
    expect(opsOffsetMinutes(Date.UTC(2026, 10, 14, 16, 0), NY)).toBe(-300); // Nov 14, EST
    expect(tzOff(NY, new Date(Date.UTC(2026, 10, 14, 16, 0, 0, 999)))).toBe(-300); // whole minutes, ms ignored
  });

  it("turns an Eastern wall time into the right instant on an EDT day and an EST day", () => {
    expect(new Date(opsWallTimeToMs("2026-10-31", 8, 0, NY)).toISOString()).toBe("2026-10-31T12:00:00.000Z");
    expect(new Date(opsWallTimeToMs("2026-11-14", 8, 0, NY)).toISOString()).toBe("2026-11-14T13:00:00.000Z");
    expect(new Date(opsWallTimeToMs("2026-11-14", 8, 40, NY)).toISOString()).toBe("2026-11-14T13:40:00.000Z"); // first stop 8:40 AM EST
    expect(new Date(opsWallTimeToMs("2026-07-04", 21, 30, NY)).toISOString()).toBe("2026-07-05T01:30:00.000Z");
    expect(new Date(opsWallTimeToMs("2026-11-14", 21, 30, NY)).toISOString()).toBe("2026-11-15T02:30:00.000Z"); // 9:30 PM EST
  });

  it("gets the switch days themselves right (Nov 1 fall back, Mar 8 spring forward)", () => {
    expect(new Date(opsWallTimeToMs("2026-11-01", 0, 0, NY)).toISOString()).toBe("2026-11-01T04:00:00.000Z"); // midnight still EDT
    expect(new Date(opsWallTimeToMs("2026-11-01", 8, 0, NY)).toISOString()).toBe("2026-11-01T13:00:00.000Z"); // 8 AM already EST
    expect(new Date(opsWallTimeToMs("2026-03-08", 8, 0, NY)).toISOString()).toBe("2026-03-08T12:00:00.000Z"); // 8 AM already EDT
    // Wall clock minutes into the day: 8:00 AM is 480 even though only 7 or 9 real hours passed since midnight.
    expect(opsMinutesIntoDay(Date.parse("2026-11-01T13:00:00Z"), "2026-11-01", NY)).toBe(480);
    expect(opsMinutesIntoDay(Date.parse("2026-03-08T12:00:00Z"), "2026-03-08", NY)).toBe(480);
    expect(opsMinutesIntoDay(Date.parse("2026-11-14T13:00:00Z"), "2026-11-14", NY)).toBe(480);
  });

  it("puts an evening instant on its Eastern day, not the next UTC day", () => {
    expect(opsYmdOfMs(Date.parse("2026-11-15T02:30:00Z"), NY)).toBe("2026-11-14"); // 9:30 PM EST Nov 14
    expect(opsYmdOfMs(Date.parse("2026-07-05T01:30:00Z"), NY)).toBe("2026-07-04"); // 9:30 PM EDT Jul 4
  });

  it("round trips the Add shift form on both sides of the switch", () => {
    expect(opsLocalInputToIso("2026-10-31T08:00")).toBe("2026-10-31T12:00:00.000Z");
    expect(opsLocalInputToIso("2026-11-14T08:00")).toBe("2026-11-14T13:00:00.000Z");
    expect(isoToOpsLocalInput("2026-11-14T13:00:00.000Z")).toBe("2026-11-14T08:00");
    expect(isoToOpsLocalInput("2026-10-31T12:00:00.000Z")).toBe("2026-10-31T08:00");
  });
});
