import { describe, it, expect } from "vitest";
import { heuristicSentiment, NEGATIVE_THRESHOLD } from "./sentiment";

describe("comms — heuristic sentiment (deterministic fallback)", () => {
  it("flags an angry, demanding caller as negative", () => {
    const s = heuristicSentiment(
      "This is absolutely UNACCEPTABLE. I am furious — the tent showed up damaged and no one called me back. I want a refund.",
    );
    expect(s.isNegative).toBe(true);
    expect(s.label).toBe("negative");
    expect(s.score).toBeGreaterThanOrEqual(NEGATIVE_THRESHOLD);
    expect(s.method).toBe("heuristic");
    expect(s.reasons.length).toBeGreaterThan(0);
  });

  it("does not flag a normal logistics question", () => {
    const s = heuristicSentiment("Hi, I wanted to confirm the delivery window for Saturday and ask about table sizes.");
    expect(s.isNegative).toBe(false);
    expect(s.label).not.toBe("negative");
  });

  it("treats warm, thankful language as positive/neutral, not an alert", () => {
    const s = heuristicSentiment("Thank you so much, everything was perfect and the crew was great. Really appreciate it!");
    expect(s.isNegative).toBe(false);
  });

  it("empty / missing transcript is neutral and not an alert (no fabrication)", () => {
    expect(heuristicSentiment("").isNegative).toBe(false);
    expect(heuristicSentiment(null).label).toBe("neutral");
    expect(heuristicSentiment(undefined).reasons).toContain("no transcript text");
  });

  it("a single mild issue word is not enough to alert; stacked frustration is", () => {
    expect(heuristicSentiment("The order was a little late.").isNegative).toBe(false);
    const stacked = heuristicSentiment("I'm frustrated and disappointed, this is the worst service, you were late and rude.");
    expect(stacked.isNegative).toBe(true);
  });

  it("scores are clamped to [0,1]", () => {
    const s = heuristicSentiment(
      "unacceptable ridiculous worst furious refund cancel scam incompetent fed up disgusted frustrated angry upset!!!",
    );
    expect(s.score).toBeLessThanOrEqual(1);
    expect(s.score).toBeGreaterThan(0);
  });
});
