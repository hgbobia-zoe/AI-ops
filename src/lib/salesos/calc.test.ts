import { describe, it, expect } from "vitest";
import { deriveSalesState, nextBestAction, priorityScore, DEFAULT_THRESHOLDS, type LeadSignals } from "./calc";

const base: LeadSignals = { daysToEvent: 40, quoteAgeDays: 1, everSent: true, hasPhone: true, hasEmail: true, value: 3000 };

describe("salesos — deriveSalesState", () => {
  it("an imminent event beats everything else (closing window)", () => {
    expect(deriveSalesState({ ...base, daysToEvent: 5, everSent: false })).toBe("closing");
    expect(deriveSalesState({ ...base, daysToEvent: 14, quoteAgeDays: 90 })).toBe("closing"); // even if cold by age
  });

  it("closing window does not fire for a past event", () => {
    expect(deriveSalesState({ ...base, daysToEvent: -3, quoteAgeDays: 30 })).toBe("cold");
  });

  it("unsent when the quote never went out (and event not imminent)", () => {
    expect(deriveSalesState({ ...base, daysToEvent: 40, everSent: false })).toBe("unsent");
  });

  it("awaiting inside the grace window, follow_up past it, cold after the long threshold", () => {
    expect(deriveSalesState({ ...base, quoteAgeDays: 2 })).toBe("awaiting"); // ≤3
    expect(deriveSalesState({ ...base, quoteAgeDays: 3 })).toBe("awaiting"); // ==grace, not past yet
    expect(deriveSalesState({ ...base, quoteAgeDays: 4 })).toBe("follow_up"); // >3
    expect(deriveSalesState({ ...base, quoteAgeDays: 20 })).toBe("follow_up"); // <21
    expect(deriveSalesState({ ...base, quoteAgeDays: 21 })).toBe("cold"); // ≥21
  });

  it("sent but undatable age falls back to follow_up, not a guess", () => {
    expect(deriveSalesState({ ...base, quoteAgeDays: null, daysToEvent: 40 })).toBe("follow_up");
  });

  it("undated event is scored by send-state / age, never as closing", () => {
    expect(deriveSalesState({ ...base, daysToEvent: null, everSent: false })).toBe("unsent");
    expect(deriveSalesState({ ...base, daysToEvent: null, quoteAgeDays: 30 })).toBe("cold");
  });
});

describe("salesos — nextBestAction", () => {
  it("routes an unsent quote to 'Send the quote' with now urgency", () => {
    const a = nextBestAction("unsent", { ...base, everSent: false });
    expect(a.action).toMatch(/send the quote/i);
    expect(a.urgency).toBe("now");
  });

  it("prefers a call for a closing lead and states the countdown", () => {
    const a = nextBestAction("closing", { ...base, daysToEvent: 2, hasPhone: true });
    expect(a.channel).toBe("call");
    expect(a.urgency).toBe("now");
    expect(a.reason).toMatch(/in 2 days/);
  });

  it("falls back to email when there's no phone, and to unknown when there's neither", () => {
    expect(nextBestAction("follow_up", { ...base, hasPhone: false, hasEmail: true }).channel).toBe("email");
    const none = nextBestAction("follow_up", { ...base, hasPhone: false, hasEmail: false });
    expect(none.channel).toBe("unknown");
    expect(none.action).toMatch(/no phone\/email/i);
  });

  it("awaiting is a monitor action, not an outreach", () => {
    const a = nextBestAction("awaiting", { ...base, quoteAgeDays: 1 });
    expect(a.urgency).toBe("monitor");
  });
});

describe("salesos — priorityScore", () => {
  it("ranks an imminent high-value unsigned lead above a distant small one", () => {
    const hot = priorityScore("closing", { ...base, daysToEvent: 3, value: 12000 });
    const cold = priorityScore("awaiting", { ...base, daysToEvent: 90, value: 800 });
    expect(hot.score).toBeGreaterThan(cold.score);
  });

  it("gives no proximity points for a past or undated event, and no value points for unknown value", () => {
    const past = priorityScore("cold", { ...base, daysToEvent: -5, value: null, quoteAgeDays: 30 });
    // stage base (cold=15) + aging (30/3=10) only; no proximity, no value.
    expect(past.factors.some((f) => f.label.includes("Event"))).toBe(false);
    expect(past.factors.some((f) => f.label === "Deal size")).toBe(false);
    expect(past.score).toBe(15 + 10);
  });

  it("exposes an explainable factor breakdown that sums to the score", () => {
    const p = priorityScore("follow_up", { ...base, daysToEvent: 10, value: 6000, quoteAgeDays: 9 });
    expect(p.factors.reduce((n, f) => n + f.points, 0)).toBe(p.score);
    expect(p.factors.length).toBeGreaterThanOrEqual(3); // stage + proximity + value (+ aging)
  });

  it("uses the default thresholds when none are passed", () => {
    expect(DEFAULT_THRESHOLDS.closingWindowDays).toBe(14);
  });
});
