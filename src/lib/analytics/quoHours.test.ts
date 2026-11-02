import { describe, it, expect } from "vitest";
import { aggregate, inSalesHours, localParts, type QuoEvent } from "./quoHours";

describe("quoHours", () => {
  it("buckets in Eastern time", () => {
    // 2026-07-06 is a Monday; 14:30Z = 10:30 EDT
    expect(localParts("2026-07-06T14:30:00Z")).toMatchObject({ dow: 1, hour: 10, month: 7 });
  });

  it("knows the posted hours", () => {
    expect(inSalesHours(1, 9)).toBe(false);
    expect(inSalesHours(1, 17)).toBe(true);
    expect(inSalesHours(6, 13)).toBe(false);
    expect(inSalesHours(0, 12)).toBe(false);
  });

  it("counts calls, misses, after-hours and reply time", () => {
    const ev: QuoEvent[] = [
      { kind: "call", dir: "in", at: "2026-07-06T23:00:00Z", missed: true, who: "a" }, // Mon 7pm, after hours
      { kind: "text", dir: "out", at: "2026-07-07T14:00:00Z", who: "a" }, // reply next day 10am (15h)
      { kind: "text", dir: "in", at: "2026-07-07T15:00:00Z", who: "b" }, // Tue 11am
      { kind: "text", dir: "out", at: "2026-07-07T15:10:00Z", who: "b" }, // 10 min reply
    ];
    const r = aggregate(ev, "2026-07-01T00:00:00Z", "2026-07-31T00:00:00Z", 2);
    expect(r.totals).toMatchObject({ callsIn: 1, callsMissed: 1, textsIn: 1, textsOut: 2 });
    expect(r.afterHours).toMatchObject({ inbound: 1, missedCalls: 1, share: 50 });
    expect(r.grid.all[1][19]).toMatchObject({ callsIn: 1, callsMissed: 1, medianReplyMins: 900 });
    expect(r.grid.all[2][11].medianReplyMins).toBe(10);
    expect(r.grid.off[2][11].textsIn).toBe(0);
    expect(r.grid.peak[2][11].textsIn).toBe(1);
  });
});
