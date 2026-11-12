import { describe, expect, it } from "vitest";
import { crewWindow, floorToQuarterHour } from "./quarterHour";

const TZ = "America/New_York";
// Nov 14 2026 is EST (UTC-5): local h:m = UTC (h+5):m.
const est = (h: number, m: number, s = 0): number => Date.UTC(2026, 10, 14, h + 5, m, s);
const hm = (ms: number): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(ms).replace(/^0(\d)/, "$1");

describe("floorToQuarterHour", () => {
  it("rounds down to the previous quarter, never the nearest", () => {
    expect(hm(floorToQuarterHour(est(8, 3), TZ))).toBe("8:00");
    expect(hm(floorToQuarterHour(est(7, 54), TZ))).toBe("7:45");
    expect(hm(floorToQuarterHour(est(8, 44, 59), TZ))).toBe("8:30");
  });

  it("leaves a time already on a quarter alone", () => {
    expect(floorToQuarterHour(est(8, 0), TZ)).toBe(est(8, 0));
    expect(floorToQuarterHour(est(7, 45), TZ)).toBe(est(7, 45));
  });

  it("8:00 through 8:14 all give 8:00, and seconds are dropped", () => {
    for (let m = 0; m <= 14; m++) expect(floorToQuarterHour(est(8, m, 30), TZ)).toBe(est(8, 0));
    expect(floorToQuarterHour(est(8, 15, 0), TZ)).toBe(est(8, 15));
  });

  it("handles midnight and just after it without crossing into the day before", () => {
    expect(floorToQuarterHour(est(0, 0), TZ)).toBe(est(0, 0));
    expect(floorToQuarterHour(est(0, 7), TZ)).toBe(est(0, 0));
    expect(hm(floorToQuarterHour(est(23, 59), TZ))).toBe("23:45");
  });

  it("works in summer time (EDT) too", () => {
    const edt = Date.UTC(2026, 6, 4, 12, 3); // 8:03 EDT
    expect(hm(floorToQuarterHour(edt, TZ))).toBe("8:00");
  });
});

describe("crewWindow", () => {
  it("moves the start down to the quarter and keeps the same length", () => {
    const w = { startUnix: est(8, 3) / 1000, endUnix: est(15, 33) / 1000, rawStart: est(9, 3) / 1000, rawEnd: est(14, 33) / 1000, known: true };
    const c = crewWindow(w, TZ);
    expect(hm(c.startUnix * 1000)).toBe("8:00");
    expect(hm(c.endUnix * 1000)).toBe("15:30");
    expect(c.endUnix - c.startUnix).toBe(w.endUnix - w.startUnix);
    expect(c.rawStart).toBe(w.rawStart); // stop times are not touched
  });
});
