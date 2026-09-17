import { describe, it, expect } from "vitest";
import { deriveTiming, type TimingInput } from "./timing";

const TODAY = "2026-09-17";
const base: TimingInput = { startDate: null, category: "CONFERENCE", expectedAttendance: 500, recurring: false, today: TODAY };

describe("deriveTiming", () => {
  it("handles an unknown date honestly", () => {
    const t = deriveTiming({ ...base, startDate: null });
    expect(t.phase).toBe("DATE_UNKNOWN");
  });

  it("classifies phases by days to event", () => {
    expect(deriveTiming({ ...base, startDate: "2026-09-25" }).phase).toBe("IMMINENT"); // 8d
    expect(deriveTiming({ ...base, startDate: "2026-12-01" }).phase).toBe("ACTIVELY_SHOPPING"); // ~75d
    expect(deriveTiming({ ...base, startDate: "2027-03-01" }).phase).toBe("OUTREACH_WINDOW"); // ~165d
    expect(deriveTiming({ ...base, startDate: "2027-08-01" }).phase).toBe("PLANNING_WINDOW"); // ~318d
    expect(deriveTiming({ ...base, startDate: "2028-06-01" }).phase).toBe("TOO_EARLY"); // >365d
    expect(deriveTiming({ ...base, startDate: "2026-01-01" }).phase).toBe("PAST");
  });

  it("marks the recommendation as inferred-from-date-only without a procurement signal", () => {
    expect(deriveTiming({ ...base, startDate: "2027-03-01" }).inferredFromDateOnly).toBe(true);
    expect(deriveTiming({ ...base, startDate: "2027-03-01", hasProcurementSignal: true }).inferredFromDateOnly).toBe(false);
  });

  it("recommends an earlier window for large / recurring events", () => {
    expect(deriveTiming({ ...base, startDate: "2027-03-01", expectedAttendance: 2000 }).outreachWindow).toMatch(/6.9/);
    expect(deriveTiming({ ...base, startDate: "2027-03-01", category: "NETWORKING", expectedAttendance: 80 }).outreachWindow).toMatch(/4.6/);
  });
});
