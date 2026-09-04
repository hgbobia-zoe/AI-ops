import { describe, it, expect } from "vitest";
import { weekStartOf, bookingPipeline, monthlyPipeline } from "./calc";

describe("sales — week bucketing", () => {
  it("weekStartOf returns the containing Monday (Mon–Sun weeks)", () => {
    expect(weekStartOf("2026-09-02")).toBe("2026-08-31"); // Wed → that week's Monday
    expect(weekStartOf("2026-08-31")).toBe("2026-08-31"); // Monday → itself
    expect(weekStartOf("2026-09-06")).toBe("2026-08-31"); // Sunday → same week's Monday
  });

  it("buckets events into the right upcoming weeks and counts each once", () => {
    const today = "2026-09-02"; // week of Aug 30 – Sep 5
    const events = [
      { date: "2026-09-02" }, // week 0
      { date: "2026-09-05" }, // week 0
      { date: "2026-09-10" }, // week 1 (Sep 6–12)
      { date: "2026-09-20" }, // week 2 (Sep 13–19)? no — Sep 20 is week 3
      { date: "2026-08-20" }, // before horizon → ignored
    ];
    const p = bookingPipeline(events, today, { weeks: 8, nearTermWeeks: 2 });
    expect(p[0].count).toBe(2);
    expect(p[1].count).toBe(1);
    expect(p.reduce((n, b) => n + b.count, 0)).toBe(4); // the pre-horizon one is not bucketed
  });

  it("sums booking revenue per week; null when a week has no priced booking", () => {
    const today = "2026-09-02";
    const p = bookingPipeline(
      [
        { date: "2026-09-02", revenue: 1000 },
        { date: "2026-09-04", revenue: 500 },
        { date: "2026-09-10", revenue: null }, // week 1: booked but unpriced
      ],
      today,
      { weeks: 8, nearTermWeeks: 2 },
    );
    expect(p[0].revenue).toBe(1500); // week 0 sums both
    expect(p[1].revenue).toBe(null); // week 1 booked but no known revenue
    expect(p[2].revenue).toBe(null); // empty week
  });

  it("splits signed contracts from open quotes per week", () => {
    const today = "2026-09-02";
    const p = bookingPipeline(
      [
        { date: "2026-09-02", revenue: 5000, signed: true },
        { date: "2026-09-04", revenue: 500, signed: true },
        { date: "2026-09-04", revenue: 690, signed: false }, // open quote
      ],
      today,
      { weeks: 8, nearTermWeeks: 2 },
    );
    expect(p[0].count).toBe(3);
    expect(p[0].signedCount).toBe(2);
    expect(p[0].signedRevenue).toBe(5500); // signed only
    expect(p[0].actionNeededCount).toBe(1); // the open quote
    expect(p[0].actionNeededRevenue).toBe(690); // potential $ to win
    expect(p[0].revenue).toBe(6190); // total incl. the quote
  });

  it("buckets a year into 12 months, splitting signed vs action-needed and ignoring other years", () => {
    const m = monthlyPipeline(
      [
        { date: "2025-01-10", revenue: 1000, signed: true },
        { date: "2025-01-20", revenue: 400, signed: false }, // action needed
        { date: "2025-03-05", revenue: 800, signed: true },
        { date: "2024-12-31", revenue: 999, signed: true }, // different year → ignored
      ],
      2025,
    );
    expect(m).toHaveLength(12);
    expect(m[0].label).toBe("Jan");
    expect(m[0].signedCount).toBe(1);
    expect(m[0].signedRevenue).toBe(1000);
    expect(m[0].actionNeededCount).toBe(1);
    expect(m[0].actionNeededRevenue).toBe(400);
    expect(m[0].revenue).toBe(1400);
    expect(m[2].signedRevenue).toBe(800); // March
    expect(m[11].count).toBe(0); // Dec 2024 not counted in 2025
    expect(m.reduce((n, b) => n + b.count, 0)).toBe(3);
  });

  it("flags a near-term empty week, but not a far-out empty week", () => {
    const today = "2026-09-02";
    const events = [{ date: "2026-09-10" }]; // only week 1 has a booking
    const p = bookingPipeline(events, today, { weeks: 8, nearTermWeeks: 2 });
    expect(p[0].nearTermGap).toBe(true); // week 0 empty + near-term → flagged
    expect(p[1].nearTermGap).toBe(false); // has a booking
    expect(p[5].nearTermGap).toBe(false); // far-out empty → not flagged
  });
});
