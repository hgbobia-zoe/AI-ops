import { describe, expect, it } from "vitest";
import { crewWindow, roundToNearestQuarterHour } from "./quarterHour";

const TZ = "America/New_York";
// Nov 14 2026 is EST (UTC-5): local h:m on Nov 14 = UTC (h+5):m.
const est = (h: number, m: number, s = 0, day = 14): number => Date.UTC(2026, 10, day, h + 5, m, s);
const hm = (ms: number): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(ms).replace(/^0(\d)/, "$1");
const round = (ms: number): number => roundToNearestQuarterHour(ms, TZ);

describe("roundToNearestQuarterHour", () => {
  it("rounds to the nearest quarter (the owner's examples)", () => {
    expect(hm(round(est(8, 3)))).toBe("8:00");
    expect(hm(round(est(7, 54)))).toBe("8:00");
    expect(hm(round(est(7, 52)))).toBe("7:45");
    expect(hm(round(est(7, 53)))).toBe("8:00");
    expect(hm(round(est(7, 40)))).toBe("7:45");
    expect(hm(round(est(15, 10)))).toBe("15:15");
  });

  it("0 to 7 minutes past a quarter rounds down, 8 to 14 rounds up, judged on whole minutes", () => {
    for (let m = 0; m <= 7; m++) expect(round(est(8, m))).toBe(est(8, 0));
    for (let m = 8; m <= 14; m++) expect(round(est(8, m))).toBe(est(8, 15));
    expect(round(est(8, 7, 59))).toBe(est(8, 0)); // still 7 whole minutes past
  });

  it("leaves a time already on a quarter alone", () => {
    expect(round(est(8, 0))).toBe(est(8, 0));
    expect(round(est(7, 45))).toBe(est(7, 45));
  });

  it("rolls over the hour (7:53 → 8:00)", () => {
    expect(round(est(7, 53))).toBe(est(8, 0));
  });

  it("rolls over midnight into the next day (11:53 PM → 12:00 AM)", () => {
    const r = round(est(23, 53));
    expect(r).toBe(est(0, 0, 0, 15));
    expect(new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(r)).toBe("2026-11-15");
    expect(round(est(0, 4))).toBe(est(0, 0)); // just after midnight stays on that day
  });

  it("works in summer time (EDT) too", () => {
    expect(hm(roundToNearestQuarterHour(Date.UTC(2026, 6, 4, 12, 3), TZ))).toBe("8:00"); // 8:03 EDT
  });
});

describe("crewWindow", () => {
  it("rounds only the start and leaves the end exactly where the route put it", () => {
    const w = { startUnix: est(7, 40) / 1000, endUnix: est(17, 0) / 1000, rawStart: est(8, 40) / 1000, rawEnd: est(16, 0) / 1000, known: true };
    const c = crewWindow(w, TZ);
    expect(hm(c.startUnix * 1000)).toBe("7:45");
    expect(c.endUnix).toBe(w.endUnix); // 5:00 PM stays 5:00 PM
    expect(c.rawStart).toBe(w.rawStart);
  });

  it("does not round an off quarter end", () => {
    const w = { startUnix: est(8, 3) / 1000, endUnix: est(15, 40) / 1000, rawStart: 0, rawEnd: 0, known: true };
    expect(hm(crewWindow(w, TZ).endUnix * 1000)).toBe("15:40");
  });

  it("keeps the original start when rounding would reach the end (very short shift)", () => {
    const w = { startUnix: est(8, 10) / 1000, endUnix: est(8, 14) / 1000, rawStart: 0, rawEnd: 0, known: true };
    expect(crewWindow(w, TZ)).toEqual(w); // 8:10 would round to 8:15, past the 8:14 end
  });
});
