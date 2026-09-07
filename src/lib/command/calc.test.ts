import { describe, it, expect } from "vitest";
import { sevenDayOutlook, dayStatus, pctOfTarget, computeRevenueOutlook } from "./calc";

describe("command center — calc", () => {
  it("builds a 7-day outlook, summing signed revenue and folding in capacity verdicts", () => {
    const today = "2026-09-03"; // Thu
    const bookings = [
      { date: "2026-09-03", revenue: 1000, signed: true },
      { date: "2026-09-03", revenue: 500, signed: false }, // quote — counts as a job, not revenue
      { date: "2026-09-05", revenue: 2000, signed: true },
    ];
    const cap = new Map([["2026-09-05", "CONSTRAINED"]]);
    const days = sevenDayOutlook(today, bookings, cap, 7);

    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ date: "2026-09-03", dow: "Thu", isToday: true, jobs: 2, revenue: 1000 });
    expect(days[0].verdict).toBeNull();
    expect(days[2]).toMatchObject({ date: "2026-09-05", jobs: 1, revenue: 2000, verdict: "CONSTRAINED" });
    expect(days[1].jobs).toBe(0); // empty day
    expect(days[1].revenue).toBeNull();
  });

  it("classifies day status by load and attention", () => {
    expect(dayStatus(0, 0, false)).toBe("quiet");
    expect(dayStatus(5, 0, false)).toBe("normal");
    expect(dayStatus(14, 0, false)).toBe("busy");
    expect(dayStatus(14, 0, true)).toBe("at-risk"); // capacity constrained overrides
    expect(dayStatus(3, 1, false)).toBe("at-risk"); // a high/critical item overrides
  });

  it("computes percent of target, null when target is missing or zero", () => {
    expect(pctOfTarget(4280, 5000)).toBe(86);
    expect(pctOfTarget(null, 5000)).toBeNull();
    expect(pctOfTarget(4280, null)).toBeNull();
    expect(pctOfTarget(4280, 0)).toBeNull();
  });

  it("classifies revenue path-to-target by coverage, not run-rate", () => {
    const base = { periodLabel: "September", pctElapsed: 60 };
    // committed already over target → met
    expect(computeRevenueOutlook({ ...base, target: 300, committed: 320, pipeline: 40 }).status).toBe("met");
    // committed short, but open quotes can close the gap → likely
    const likely = computeRevenueOutlook({ ...base, target: 300, committed: 277, pipeline: 40 });
    expect(likely.status).toBe("likely");
    expect(likely.remaining).toBe(23);
    expect(likely.ceiling).toBe(317);
    expect(likely.gapAfterPipeline).toBeNull();
    // short even if every quote closes → at-risk, with the residual gap surfaced
    const risk = computeRevenueOutlook({ ...base, target: 300, committed: 200, pipeline: 50 });
    expect(risk.status).toBe("at-risk");
    expect(risk.gapAfterPipeline).toBe(50);
    // no target / no data are explicit, never faked
    expect(computeRevenueOutlook({ ...base, target: null, committed: 100, pipeline: 0 }).status).toBe("no-target");
    expect(computeRevenueOutlook({ ...base, target: 300, committed: null, pipeline: 0 }).status).toBe("no-data");
  });
});
