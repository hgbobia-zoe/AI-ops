import { describe, expect, it } from "vitest";
import { computeBreakDecision, isBreakEligible, renderBreakReminder, shiftDurationHours, type BreakPolicy } from "./breaks";
import { DEFAULT_BREAK_POLICY } from "./breakConfig";

const policy: BreakPolicy = DEFAULT_BREAK_POLICY; // threshold 5h, fraction 0.5, minWorked 120, qualifying 20, buffer 30

// A 8h shift 09:00-17:00 UTC.
const START = "2026-10-23T09:00:00.000Z";
const END = "2026-10-23T17:00:00.000Z";

describe("eligibility", () => {
  it("eligible at/over the threshold, not under", () => {
    expect(isBreakEligible(START, END, policy)).toBe(true); // 8h
    expect(isBreakEligible(START, "2026-10-23T13:00:00.000Z", policy)).toBe(false); // 4h
    expect(shiftDurationHours(START, END)).toBe(8);
  });
});

describe("computeBreakDecision", () => {
  it("not_eligible for a short shift", () => {
    const d = computeBreakDecision({ shiftStart: START, shiftEnd: "2026-10-23T13:00:00.000Z", now: "2026-10-23T11:00:00.000Z", policy, recordedBreaks: [] });
    expect(d.action).toBe("not_eligible");
  });

  it("not_due before the reminder time (midpoint = 13:00)", () => {
    const d = computeBreakDecision({ shiftStart: START, shiftEnd: END, now: "2026-10-23T11:30:00.000Z", policy, recordedBreaks: [] });
    expect(d).toMatchObject({ action: "not_due", reminderAt: "2026-10-23T13:00:00.000Z" });
  });

  it("remind once the reminder time is reached and shift still running", () => {
    const d = computeBreakDecision({ shiftStart: START, shiftEnd: END, now: "2026-10-23T13:05:00.000Z", policy, recordedBreaks: [] });
    expect(d).toMatchObject({ action: "remind", adjustedForActivity: false });
  });

  it("skips when a qualifying break (>= 20 min) is already recorded", () => {
    const d = computeBreakDecision({
      shiftStart: START,
      shiftEnd: END,
      now: "2026-10-23T13:05:00.000Z",
      policy,
      recordedBreaks: [{ start: "2026-10-23T12:00:00.000Z", end: "2026-10-23T12:30:00.000Z" }],
    });
    expect(d).toEqual({ action: "skip", reason: "already_recorded" });
  });

  it("skips while currently on break (open record)", () => {
    const d = computeBreakDecision({ shiftStart: START, shiftEnd: END, now: "2026-10-23T13:05:00.000Z", policy, recordedBreaks: [{ start: "2026-10-23T13:00:00.000Z", end: null }] });
    expect(d.action).toBe("skip");
  });

  it("does NOT skip for a too-short break (10 min) — still reminds", () => {
    const d = computeBreakDecision({ shiftStart: START, shiftEnd: END, now: "2026-10-23T13:05:00.000Z", policy, recordedBreaks: [{ start: "2026-10-23T12:00:00.000Z", end: "2026-10-23T12:10:00.000Z" }] });
    expect(d.action).toBe("remind");
  });

  it("missed once the shift ends with no qualifying break (an exception, not a verdict)", () => {
    const d = computeBreakDecision({ shiftStart: START, shiftEnd: END, now: "2026-10-23T17:30:00.000Z", policy, recordedBreaks: [] });
    expect(d.action).toBe("missed");
  });

  it("pushes the reminder past a critical window (predictable fallback) and flags it adjusted", () => {
    // Midpoint 13:00 collides with a 13:10 delivery window (within 30 min buffer) → pushed to 13:40.
    const d = computeBreakDecision({
      shiftStart: START,
      shiftEnd: END,
      now: "2026-10-23T14:00:00.000Z",
      policy,
      recordedBreaks: [],
      criticalWindows: ["2026-10-23T13:10:00.000Z"],
    });
    expect(d.action).toBe("remind");
    if (d.action === "remind") {
      expect(d.adjustedForActivity).toBe(true);
      expect(d.reminderAt).toBe("2026-10-23T13:40:00.000Z");
    }
  });
});

describe("renderBreakReminder", () => {
  it("is short, names the worker, and carries no dashes or emoji", () => {
    const msg = renderBreakReminder("Marquis");
    expect(msg).toContain("Hi Marquis");
    expect(msg).toContain("record your break in Connecteam");
    expect(msg).not.toMatch(/[—–]/);
    expect(msg).not.toMatch(/[\u{1F300}-\u{1FAFF}☀-➿]/u);
  });
  it("falls back gracefully with no name", () => {
    expect(renderBreakReminder("")).toContain("Hi there");
  });
});
