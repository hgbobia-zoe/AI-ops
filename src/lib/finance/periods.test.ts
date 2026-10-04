import { describe, it, expect } from "vitest";
import { getPeriod, priorWeek, priorCycle, DEFAULT_OPS_CYCLE } from "./periods";

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
