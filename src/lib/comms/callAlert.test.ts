import { describe, it, expect } from "vitest";
import { callAlertTitle, isEscalationSentiment } from "./callAlert";
import { heuristicSentiment } from "./sentiment";
import type { Sentiment } from "./sentiment";

const sentiment = (over: Partial<Sentiment>): Sentiment => ({
  label: "negative",
  score: 0.7,
  isNegative: true,
  method: "heuristic",
  reasons: [],
  ...over,
});

describe("comms — call alert title (pure, honest, classification-driven)", () => {
  it("a genuinely frustrated / escalation caller keeps the urgent frustrated-caller title", () => {
    const s = heuristicSentiment(
      "This is absolutely UNACCEPTABLE. I am furious and I want a refund right now.",
    );
    expect(s.isNegative).toBe(true);
    // Escalation cues decide the title regardless of the call reason.
    const t = callAlertTitle(s, "COMPLAINT");
    expect(t.heading).toBe("Frustrated caller");
    expect(t.emoji).toBe(":rotating_light:");
  });

  it("an LLM negative verdict is treated as genuine frustration", () => {
    const t = callAlertTitle(sentiment({ method: "llm", reasons: ["sounds upset about the delay"] }));
    expect(t.heading).toBe("Frustrated caller");
  });

  it("a negative-tone call with only factual damage cues is NOT titled 'Frustrated caller'", () => {
    // broken/damaged/missing/wrong are MILD factual cues, not emotional escalation.
    const s = sentiment({ reasons: ["broken / damaged", "missing", "wrong", "problem"] });
    expect(isEscalationSentiment(s)).toBe(false);
    const t = callAlertTitle(s, "DAMAGE");
    expect(t.heading).toBe("Damage reported");
    expect(t.heading).not.toBe("Frustrated caller");
  });

  it("names a specific, heuristic-supported operational signal when there is no anger", () => {
    const s = sentiment({ reasons: ["broken / damaged"] });
    expect(callAlertTitle(s, "CANCELLATION").heading).toBe("Possible cancellation");
    expect(callAlertTitle(s, "COMPLAINT").heading).toBe("Complaint");
    expect(callAlertTitle(s, "BILLING").heading).toBe("Billing concern");
    expect(callAlertTitle(s, "PAYMENT").heading).toBe("Billing concern");
  });

  it("falls back to a neutral 'Call insight' when nothing more specific is detected", () => {
    const s = sentiment({ reasons: ["problem", "waiting"] });
    const t = callAlertTitle(s, "GENERAL_QUESTION");
    expect(t.heading).toBe("Call insight");
    expect(t.emoji).toBe(":telephone_receiver:");
  });

  it("the title is NOT a blanket constant — different classifications yield different headings", () => {
    const frustrated = callAlertTitle(sentiment({ reasons: ["furious", "wants refund"] }), "COMPLAINT");
    const damage = callAlertTitle(sentiment({ reasons: ["broken / damaged"] }), "DAMAGE");
    const insight = callAlertTitle(sentiment({ reasons: ["problem"] }), "OTHER");
    const headings = new Set([frustrated.heading, damage.heading, insight.heading]);
    expect(headings.size).toBe(3);
  });

  it("new title text carries no dashes or emoji characters (house comms style)", () => {
    const headings = [
      callAlertTitle(sentiment({ reasons: ["furious"] })).heading,
      callAlertTitle(sentiment({ reasons: ["problem"] }), "CANCELLATION").heading,
      callAlertTitle(sentiment({ reasons: ["problem"] }), "DAMAGE").heading,
      callAlertTitle(sentiment({ reasons: ["problem"] }), "OTHER").heading,
    ];
    for (const h of headings) {
      expect(h).not.toMatch(/[-—–]/);
      // eslint-disable-next-line no-control-regex
      expect(h).toMatch(/^[\x00-\x7F]+$/); // ASCII only — no emoji in the heading text
    }
  });
});
