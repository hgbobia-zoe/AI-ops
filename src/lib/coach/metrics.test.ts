import { describe, it, expect } from "vitest";
import { computeCallMetrics, speedGauge, balanceGauge, sentimentGauge, momentumScore } from "./metrics";

describe("computeCallMetrics", () => {
  it("computes words/min, questions, turns, and talk balance from a labelled transcript", () => {
    const transcript = [
      "Rep: Thanks for calling, how can I help you today?",
      "Customer: We need a tent for a wedding.",
      "Rep: Great. How many guests are you expecting?",
      "Customer: About one hundred and fifty.",
    ].join("\n");
    const m = computeCallMetrics(transcript, 60); // 1 minute
    expect(m.turns).toBe(4);
    expect(m.questions).toBe(2); // two rep lines end in '?'
    expect(m.words).toBeGreaterThan(0);
    expect(m.wordsPerMin).toBe(m.words); // 1 minute → wpm === words
    expect(m.speakers).toHaveLength(2);
    // "Rep" hint → "You", "Customer" hint → "Caller".
    expect(m.speakers.map((s) => s.label).sort()).toEqual(["Caller", "You"]);
    const total = m.speakers[0].share + m.speakers[1].share;
    expect(total).toBeCloseTo(1, 5);
  });

  it("folds unlabelled continuation lines into the previous speaker", () => {
    const transcript = ["Rep: First line.", "still the rep talking.", "Customer: My reply."].join("\n");
    const m = computeCallMetrics(transcript, null);
    expect(m.turns).toBe(2); // two labelled segments
    expect(m.wordsPerMin).toBeNull(); // no duration
  });

  it("omits talk balance when there are no speaker labels", () => {
    const m = computeCallMetrics("just some text with no speaker labels at all", 120);
    expect(m.speakers).toEqual([]);
    expect(m.words).toBeGreaterThan(0);
  });

  it("is safe on empty input", () => {
    const m = computeCallMetrics("", 60);
    expect(m.words).toBe(0);
    expect(m.turns).toBe(0);
    expect(m.speakers).toEqual([]);
  });
});

describe("gauges + momentum", () => {
  it("speedGauge verdicts by wpm", () => {
    expect(speedGauge(null)).toBeNull();
    expect(speedGauge(90)?.tone).toBe("warn"); // slow
    expect(speedGauge(140)?.tone).toBe("good");
    expect(speedGauge(210)?.tone).toBe("bad"); // too fast
    expect(speedGauge(140)?.pct).toBeGreaterThan(0);
  });

  it("balanceGauge flags monologue vs balance", () => {
    expect(balanceGauge(0.5)?.tone).toBe("good");
    expect(balanceGauge(0.8)?.tone).toBe("bad"); // talked a lot
    expect(balanceGauge(0.2)?.tone).toBe("warn"); // listened a lot
  });

  it("sentimentGauge maps label to position", () => {
    expect(sentimentGauge("positive")?.pct).toBeGreaterThan(50);
    expect(sentimentGauge("negative")?.pct).toBeLessThan(50);
    expect(sentimentGauge(null)).toBeNull();
  });

  it("momentumScore composes real signals and clamps 0..100", () => {
    const strong = momentumScore({ sentiment: "positive", repShare: 0.5, questions: 4, hasNextStep: true });
    expect(strong.score).toBeGreaterThanOrEqual(70);
    expect(strong.label).toBe("Strong");
    const weak = momentumScore({ sentiment: "negative", repShare: 0.85, questions: 0, hasNextStep: false });
    expect(weak.score).toBeLessThan(45);
    expect(weak.label).toBe("At risk");
    expect(weak.score).toBeGreaterThanOrEqual(0);
  });
});
