import { describe, it, expect } from "vitest";
import { weekStartOf, bookingPipeline } from "./calc";

describe("sales — week bucketing", () => {
  it("weekStartOf returns the containing Sunday", () => {
    expect(weekStartOf("2026-09-02")).toBe("2026-08-30"); // Wed → prior Sunday
    expect(weekStartOf("2026-08-30")).toBe("2026-08-30"); // Sunday → itself
    expect(weekStartOf("2026-09-05")).toBe("2026-08-30"); // Saturday → same week's Sunday
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

  it("flags a near-term empty week, but not a far-out empty week", () => {
    const today = "2026-09-02";
    const events = [{ date: "2026-09-10" }]; // only week 1 has a booking
    const p = bookingPipeline(events, today, { weeks: 8, nearTermWeeks: 2 });
    expect(p[0].nearTermGap).toBe(true); // week 0 empty + near-term → flagged
    expect(p[1].nearTermGap).toBe(false); // has a booking
    expect(p[5].nearTermGap).toBe(false); // far-out empty → not flagged
  });
});
