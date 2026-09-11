import { describe, it, expect } from "vitest";
import { computeCallMetrics } from "./metrics";

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
