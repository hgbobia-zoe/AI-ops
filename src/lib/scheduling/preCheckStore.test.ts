import { describe, it, expect } from "vitest";
import { decidePreCheckAlert, decideScheduledUnroutedNudge, PRECHECK_ALERT_COOLOFF_MS } from "./preCheckStore";

const T0 = new Date("2026-10-10T08:00:00Z");
const later = (ms: number): Date => new Date(T0.getTime() + ms);

describe("decidePreCheckAlert (dedupe + cool-off, mirrors recordIgnitionProbe)", () => {
  it("first sight of a gap alerts and records the baseline", () => {
    const r = decidePreCheckAlert(undefined, true, 2, T0);
    expect(r.alert).toBe("gap");
    expect(r.next?.lastTotalGap).toBe(2);
    expect(r.next?.lastAlertedAt).toBe(T0.toISOString());
  });

  it("a repeat within the cool-off stays quiet (keeps the clock)", () => {
    const prev = { firstGapAt: T0.toISOString(), lastAlertedAt: T0.toISOString(), lastTotalGap: 2 };
    const r = decidePreCheckAlert(prev, true, 2, later(30 * 60_000)); // 30m later
    expect(r.alert).toBeNull();
    expect(r.next?.lastAlertedAt).toBe(T0.toISOString()); // not re-stamped
  });

  it("re-alerts once the cool-off elapses", () => {
    const prev = { firstGapAt: T0.toISOString(), lastAlertedAt: T0.toISOString(), lastTotalGap: 2 };
    const r = decidePreCheckAlert(prev, true, 2, later(PRECHECK_ALERT_COOLOFF_MS + 1));
    expect(r.alert).toBe("gap");
    expect(r.next?.lastAlertedAt).toBe(later(PRECHECK_ALERT_COOLOFF_MS + 1).toISOString());
  });

  it("re-alerts immediately when the gap WORSENS, even inside the cool-off", () => {
    const prev = { firstGapAt: T0.toISOString(), lastAlertedAt: T0.toISOString(), lastTotalGap: 1 };
    const r = decidePreCheckAlert(prev, true, 2, later(5 * 60_000)); // 5m later, but gap grew 1→2
    expect(r.alert).toBe("gap");
    expect(r.next?.lastTotalGap).toBe(2);
  });

  it("a shrinking (but still open) gap inside the cool-off does NOT re-alert", () => {
    const prev = { firstGapAt: T0.toISOString(), lastAlertedAt: T0.toISOString(), lastTotalGap: 2 };
    const r = decidePreCheckAlert(prev, true, 1, later(5 * 60_000));
    expect(r.alert).toBeNull();
  });

  it("clears with a 'recovered' note ONLY if we had alerted, then forgets the route", () => {
    const prev = { firstGapAt: T0.toISOString(), lastAlertedAt: T0.toISOString(), lastTotalGap: 2 };
    const r = decidePreCheckAlert(prev, false, 0, later(10 * 60_000));
    expect(r.alert).toBe("recovered");
    expect(r.next).toBeUndefined();
  });

  it("clearing a gap we never alerted is silent", () => {
    const prev = { firstGapAt: T0.toISOString(), lastTotalGap: 0 }; // seen but never alerted
    const r = decidePreCheckAlert(prev, false, 0, later(10 * 60_000));
    expect(r.alert).toBeNull();
    expect(r.next).toBeUndefined();
  });
});

describe("decideScheduledUnroutedNudge (schedule → route bridge, day-level dedupe)", () => {
  it("first sight of scheduled-unrouted crew nudges and records the baseline", () => {
    const r = decideScheduledUnroutedNudge(undefined, 3, T0);
    expect(r.nudge).toBe(true);
    expect(r.next?.lastCount).toBe(3);
    expect(r.next?.lastNudgedAt).toBe(T0.toISOString());
  });

  it("a repeat within the cool-off stays quiet (keeps the clock)", () => {
    const prev = { firstSeenAt: T0.toISOString(), lastNudgedAt: T0.toISOString(), lastCount: 3 };
    const r = decideScheduledUnroutedNudge(prev, 3, later(30 * 60_000));
    expect(r.nudge).toBe(false);
    expect(r.next?.lastNudgedAt).toBe(T0.toISOString());
  });

  it("re-nudges when the count GROWS, even inside the cool-off", () => {
    const prev = { firstSeenAt: T0.toISOString(), lastNudgedAt: T0.toISOString(), lastCount: 2 };
    const r = decideScheduledUnroutedNudge(prev, 4, later(5 * 60_000));
    expect(r.nudge).toBe(true);
    expect(r.next?.lastCount).toBe(4);
  });

  it("re-nudges once the cool-off elapses", () => {
    const prev = { firstSeenAt: T0.toISOString(), lastNudgedAt: T0.toISOString(), lastCount: 2 };
    const r = decideScheduledUnroutedNudge(prev, 2, later(PRECHECK_ALERT_COOLOFF_MS + 1));
    expect(r.nudge).toBe(true);
  });

  it("count 0 forgets the record and stays silent (soft prompt, no recovered note)", () => {
    const prev = { firstSeenAt: T0.toISOString(), lastNudgedAt: T0.toISOString(), lastCount: 2 };
    const r = decideScheduledUnroutedNudge(prev, 0, later(10 * 60_000));
    expect(r.nudge).toBe(false);
    expect(r.next).toBeUndefined();
  });
});
