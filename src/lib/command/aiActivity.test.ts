import { describe, it, expect } from "vitest";
import { classifyAiActivity, summarizeAiActivity, AI_ACTIVE_WINDOW_MIN } from "./aiActivity";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const minsAgo = (m: number): string => new Date(NOW - m * 60000).toISOString();
const daysAgo = (d: number): string => new Date(NOW - d * 86400000).toISOString();

describe("command center — AI activity freshness", () => {
  it("counts a running session as ACTIVE only with a fresh heartbeat", () => {
    const fresh = classifyAiActivity("running", minsAgo(5), NOW);
    expect(fresh).toMatchObject({ state: "active", stale: false, tone: "info" });
  });

  it("reports a running session with NO recent activity as idle/stale — never active, never completed", () => {
    // The exact audit bug: status says running, last activity 14 days ago.
    const stale = classifyAiActivity("running", daysAgo(14), NOW);
    expect(stale.state).toBe("idle");
    expect(stale.stale).toBe(true);
    expect(stale.state).not.toBe("active");
    expect(stale.state).not.toBe("completed");
  });

  it("treats the heartbeat window boundary inclusively", () => {
    expect(classifyAiActivity("running", minsAgo(AI_ACTIVE_WINDOW_MIN), NOW).state).toBe("active");
    expect(classifyAiActivity("running", minsAgo(AI_ACTIVE_WINDOW_MIN + 1), NOW).state).toBe("idle");
  });

  it("treats a missing timestamp as infinitely old (never active)", () => {
    expect(classifyAiActivity("running", null, NOW).state).toBe("idle");
  });

  it("keeps awaiting_approval as a waiting state, flagging stale when old", () => {
    expect(classifyAiActivity("awaiting_approval", minsAgo(2), NOW)).toMatchObject({ state: "waiting", stale: false, tone: "attention" });
    expect(classifyAiActivity("awaiting_approval", daysAgo(9), NOW)).toMatchObject({ state: "waiting", stale: true });
  });

  it("maps terminal statuses honestly", () => {
    expect(classifyAiActivity("done", daysAgo(1), NOW)).toMatchObject({ state: "completed", tone: "positive" });
    expect(classifyAiActivity("failed", minsAgo(1), NOW)).toMatchObject({ state: "error", tone: "critical" });
    expect(classifyAiActivity("cancelled", minsAgo(1), NOW)).toMatchObject({ state: "cancelled" });
    expect(classifyAiActivity("paused", minsAgo(1), NOW)).toMatchObject({ state: "paused" });
  });

  it("summarizes a mixed set with honest buckets (the '9 live' case becomes 1 active + 2 idle + 1 waiting)", () => {
    const sessions = [
      { status: "running" as const, updatedAt: minsAgo(3) }, // active
      { status: "running" as const, updatedAt: daysAgo(10) }, // idle (stale)
      { status: "running" as const, updatedAt: daysAgo(14) }, // idle (stale)
      { status: "awaiting_approval" as const, updatedAt: minsAgo(10) }, // waiting
      { status: "done" as const, updatedAt: daysAgo(1) }, // ended
      { status: "failed" as const, updatedAt: daysAgo(2) }, // ended
    ];
    expect(summarizeAiActivity(sessions, NOW)).toEqual({ active: 1, waiting: 1, idle: 2, ended: 2, total: 6 });
  });
});
