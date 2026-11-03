import { describe, it, expect } from "vitest";
import { todaysExceptions, aiActivityState, liveAiCount, dataFreshness, AI_LIVE_FRESH_MIN } from "./calc";

const ymd = (iso: string): string => iso.slice(0, 10);

describe("command center — accuracy helpers", () => {
  it("counts only exceptions on today's stops, or stopless ones logged today", () => {
    const xs = [
      { id: "a", stopId: "S1", ts: "2026-09-01T10:00:00Z" }, // old row, but its stop is on today's route
      { id: "b", stopId: "S9", ts: "2026-11-03T10:00:00Z" }, // logged today, stop is NOT on today's routes
      { id: "c", stopId: null, ts: "2026-11-03T08:00:00Z" }, // stopless, today
      { id: "d", stopId: null, ts: "2026-10-12T08:00:00Z" }, // stopless, weeks old: the bug this fixes
      { id: "e", stopId: null, ts: "not a date" },
    ];
    const out = todaysExceptions(xs, new Set(["S1", "S2"]), "2026-11-03", (iso) => {
      if (!/^\d{4}-/.test(iso)) throw new Error("bad");
      return ymd(iso);
    });
    expect(out.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("treats a running session as live only with recent activity", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    const fresh = new Date(now - 5 * 60_000).toISOString();
    const old = new Date(now - (AI_LIVE_FRESH_MIN + 1) * 60_000).toISOString();
    expect(aiActivityState({ status: "running", updatedAt: fresh }, now)).toBe("live");
    expect(aiActivityState({ status: "running", updatedAt: old }, now)).toBe("idle");
    expect(aiActivityState({ status: "running", updatedAt: "garbage" }, now)).toBe("idle");
    expect(aiActivityState({ status: "awaiting_approval", updatedAt: old }, now)).toBe("approval");
    expect(aiActivityState({ status: "done", updatedAt: fresh }, now)).toBe("other");
    expect(liveAiCount([
      { status: "running", updatedAt: fresh },
      { status: "running", updatedAt: old },
      { status: "awaiting_approval", updatedAt: fresh },
      { status: "paused", updatedAt: fresh },
    ], now)).toBe(1);
  });

  it("states how old the Goodshuffle data is and flags it past a day", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(dataFreshness(null, now)).toEqual({ at: null, ageLabel: "never", stale: true });
    expect(dataFreshness("2026-11-03T11:59:50Z", now)).toMatchObject({ ageLabel: "just now", stale: false });
    expect(dataFreshness("2026-11-03T11:48:00Z", now)).toMatchObject({ ageLabel: "12m ago", stale: false });
    expect(dataFreshness("2026-11-03T07:00:00Z", now)).toMatchObject({ ageLabel: "5h ago", stale: false });
    expect(dataFreshness("2026-11-02T10:00:00Z", now)).toMatchObject({ ageLabel: "26h ago", stale: true });
    expect(dataFreshness("2026-10-31T12:00:00Z", now)).toMatchObject({ ageLabel: "3d ago", stale: true });
  });
});
