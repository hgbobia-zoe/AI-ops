import { describe, it, expect } from "vitest";
import { getPeriod, priorWeek, priorCycle, customRange, priorRange, MAX_CUSTOM_RANGE_DAYS, DEFAULT_OPS_CYCLE } from "./periods";

// Dimension A (Mon–Sun week) is unchanged; dimension B (operational cycle) is new and can cross weeks.
describe("periods — calendar week (dimension A) unchanged", () => {
  it("this week is Monday→Sunday", () => {
    // 2026-10-01 is a Thursday.
    const p = getPeriod("thisWeek", "2026-10-01");
    expect(p.start).toBe("2026-09-28"); // Monday
    expect(p.end).toBe("2026-10-04"); // Sunday
    expect(p.isWeek).toBe(true);
  });
});

describe("periods — operational cycle (dimension B, configurable Thu→Tue)", () => {
  it("default Thu anchor, length 6 → Thu..Tue, crossing the calendar-week boundary", () => {
    const p = getPeriod("thisCycle", "2026-10-01", DEFAULT_OPS_CYCLE); // Thursday
    expect(p.start).toBe("2026-10-01"); // Thu
    expect(p.end).toBe("2026-10-06"); // Tue (crosses Sun/Mon week boundary)
    expect(p.isCycle).toBe(true);
    expect(p.isWeek).toBe(false);
  });

  it("mid-cycle date snaps back to the anchor day", () => {
    const p = getPeriod("thisCycle", "2026-10-05", DEFAULT_OPS_CYCLE); // Monday, inside the Thu cycle
    expect(p.start).toBe("2026-10-01");
    expect(p.end).toBe("2026-10-06");
  });

  it("last cycle is the immediately preceding window", () => {
    const p = getPeriod("lastCycle", "2026-10-01", DEFAULT_OPS_CYCLE);
    expect(p.start).toBe("2026-09-25"); // previous Thu
    expect(p.end).toBe("2026-09-30");
  });

  it("honors a custom anchor + length", () => {
    const p = getPeriod("thisCycle", "2026-10-01", { anchorDow: 1, lengthDays: 7 }); // Monday, 7 days
    expect(p.start).toBe("2026-09-28"); // Monday
    expect(p.end).toBe("2026-10-04");
  });
});

describe("periods — WoW / cycle-over-cycle baselines (reconciling group-bys)", () => {
  it("priorWeek shifts the Mon–Sun window back 7 days", () => {
    const wk = getPeriod("thisWeek", "2026-10-01");
    const prev = priorWeek(wk);
    expect(prev.start).toBe("2026-09-21");
    expect(prev.end).toBe("2026-09-27");
  });
  it("priorCycle shifts the cycle back by its own length", () => {
    const cyc = getPeriod("thisCycle", "2026-10-01", DEFAULT_OPS_CYCLE);
    const prev = priorCycle(cyc, DEFAULT_OPS_CYCLE);
    expect(prev.start).toBe("2026-09-25");
    expect(prev.end).toBe("2026-09-30");
  });
});

// Stage 7b — custom date range. Pure, deterministic, NEVER throws: a bad range returns null so the page
// falls back to the default preset.
describe("periods — custom date range (Stage 7b)", () => {
  const today = "2026-10-23";

  it("builds a Period in the same {start,end,label,...} shape for a valid range", () => {
    const p = customRange("2026-01-01", "2026-03-31", today);
    expect(p).not.toBeNull();
    expect(p!.key).toBe("custom");
    expect(p!.start).toBe("2026-01-01");
    expect(p!.end).toBe("2026-03-31");
    expect(p!.isWeek).toBe(false); // no weekly target, no trajectory — honest for an arbitrary span
    expect(p!.isCycle).toBeUndefined();
  });

  it("accepts a single-day range (start === end)", () => {
    const p = customRange("2026-06-15", "2026-06-15", today);
    expect(p?.start).toBe("2026-06-15");
    expect(p?.end).toBe("2026-06-15");
  });

  it("trims surrounding whitespace", () => {
    expect(customRange(" 2026-02-01 ", " 2026-02-05 ", today)?.start).toBe("2026-02-01");
  });

  it("rejects an inverted range (start > end)", () => {
    expect(customRange("2026-03-31", "2026-01-01", today)).toBeNull();
  });

  it("rejects a missing bound", () => {
    expect(customRange("2026-01-01", null, today)).toBeNull();
    expect(customRange(undefined, "2026-01-01", today)).toBeNull();
    expect(customRange("", "", today)).toBeNull();
  });

  it("rejects malformed / impossible dates", () => {
    expect(customRange("2026-13-01", "2026-13-05", today)).toBeNull(); // month 13
    expect(customRange("2026-02-30", "2026-03-01", today)).toBeNull(); // Feb 30
    expect(customRange("10/01/2026", "10/05/2026", today)).toBeNull(); // wrong format
    expect(customRange("2026-1-1", "2026-1-5", today)).toBeNull(); // not zero-padded
  });

  it("rejects out-of-bounds ranges (below the floor, too far future)", () => {
    expect(customRange("1999-12-31", "2000-01-05", today)).toBeNull(); // before MIN
    expect(customRange("2026-01-01", "2099-01-01", today)).toBeNull(); // far future end
  });

  it("rejects a span wider than the guardrail", () => {
    // ~6 years ≫ MAX_CUSTOM_RANGE_DAYS; but keep the end within the future cap by anchoring 'today' late.
    const t = "2035-01-01";
    expect(customRange("2026-01-01", "2034-01-01", t)).toBeNull();
    expect(MAX_CUSTOM_RANGE_DAYS).toBeGreaterThan(365); // sanity: at least a year is allowed
  });

  it("priorRange is the equal-length window immediately before the range", () => {
    const p = customRange("2026-03-01", "2026-03-10", today)!; // 10 days inclusive
    const prev = priorRange(p);
    expect(prev.start).toBe("2026-02-19"); // 10 days earlier
    expect(prev.end).toBe("2026-02-28");
  });
});
