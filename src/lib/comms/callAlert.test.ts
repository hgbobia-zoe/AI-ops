import { describe, it, expect } from "vitest";
import { callAlertTitle, callConcern, isEscalationSentiment } from "./callAlert";
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

describe("comms — call alert title (names the main concern, not always frustration)", () => {
  it("a genuinely angry caller keeps the urgent frustrated-caller title", () => {
    const s = heuristicSentiment("This is absolutely UNACCEPTABLE. I am furious and I want a refund right now.");
    expect(s.isNegative).toBe(true);
    const t = callAlertTitle(s, "COMPLAINT");
    expect(t.heading).toBe("Frustrated caller");
    expect(t.emoji).toBe(":rotating_light:");
  });

  it("an LLM negative verdict is NOT assumed to be frustration", () => {
    const t = callAlertTitle(sentiment({ method: "llm", reasons: ["unhappy with the quote"] }), "GENERAL_QUESTION");
    expect(t.heading).not.toBe("Frustrated caller");
    expect(t.heading).toBe("Negative tone");
  });

  it("uses the LLM's named concern when it gives one", () => {
    const llm = (concern: Sentiment["concern"]): Sentiment => sentiment({ method: "llm", concern });
    expect(callAlertTitle(llm("frustration")).heading).toBe("Frustrated caller");
    expect(callAlertTitle(llm("price_objection")).heading).toBe("Price objection");
    expect(callAlertTitle(llm("cancellation_risk")).heading).toBe("Possible cancellation");
    expect(callAlertTitle(llm("delivery_problem")).heading).toBe("Delivery problem");
    expect(callAlertTitle(llm("negative_tone")).heading).toBe("Negative tone");
    // The LLM's concern wins over the keyword reason classifier.
    expect(callAlertTitle(llm("price_objection"), "COMPLAINT").heading).toBe("Price objection");
  });

  it("a calm price objection on the keyword path is titled as a price objection", () => {
    const s = heuristicSentiment("Honestly the quote is too expensive, it is way over our budget and we found it cheaper elsewhere.");
    expect(s.reasons).toContain("price pushback");
    expect(callConcern({ ...s, isNegative: true })).toBe("price_objection");
  });

  it("a calm request to cancel is a possible cancellation, not a frustrated caller", () => {
    const s = sentiment({ reasons: ["cancel", "wants refund"] });
    expect(isEscalationSentiment(s)).toBe(false);
    expect(callAlertTitle(s).heading).toBe("Possible cancellation");
  });

  it("factual damage cues are titled as damage, not anger", () => {
    const s = sentiment({ reasons: ["broken / damaged", "missing", "wrong", "problem"] });
    expect(isEscalationSentiment(s)).toBe(false);
    expect(callAlertTitle(s, "DAMAGE").heading).toBe("Damage reported");
  });

  it("names operational signals from the reason classifier", () => {
    const s = sentiment({ reasons: ["problem"] });
    expect(callAlertTitle(s, "CANCELLATION").heading).toBe("Possible cancellation");
    expect(callAlertTitle(s, "COMPLAINT").heading).toBe("Complaint");
    expect(callAlertTitle(s, "BILLING").heading).toBe("Billing concern");
    expect(callAlertTitle(s, "PAYMENT").heading).toBe("Billing concern");
    expect(callAlertTitle(s, "DELIVERY_STATUS").heading).toBe("Delivery problem");
  });

  it("falls back to a neutral 'Negative tone' when nothing more specific is detected", () => {
    const t = callAlertTitle(sentiment({ reasons: ["problem", "waiting"] }), "GENERAL_QUESTION");
    expect(t.heading).toBe("Negative tone");
    expect(t.emoji).toBe(":telephone_receiver:");
  });

  it("heading text carries no dashes or emoji characters (house comms style)", () => {
    const concerns: Sentiment["concern"][] = [
      "frustration", "price_objection", "cancellation_risk", "complaint", "damage", "billing", "delivery_problem", "negative_tone",
    ];
    for (const c of concerns) {
      const h = callAlertTitle(sentiment({ method: "llm", concern: c })).heading;
      expect(h).not.toMatch(/[-—–]/);
      // eslint-disable-next-line no-control-regex
      expect(h).toMatch(/^[\x00-\x7F]+$/);
    }
  });
});
