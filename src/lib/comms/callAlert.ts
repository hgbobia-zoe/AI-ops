// Title for the customer-call Slack alert. RULES CALCULATE, AI INTERPRETS + honest-when-unobservable:
// the heading names what the call is MAINLY about, never a blanket label. Not every flagged call is an
// angry caller: a calm price objection, a cancellation question or a damage report each need a different
// follow-up, so each gets its own heading.
//
// Where the concern comes from, in order:
//   1) The LLM's own read (`sentiment.concern`), when the LLM judged the call and named a valid concern.
//   2) Otherwise the deterministic cues: real anger cues (furious, unacceptable, profanity, shouting) mean
//      frustration; a price cue means a price objection; then the reason classifier (cancellation, damage,
//      complaint, billing, delivery). A plain LLM "negative" with no concern is NOT assumed to be anger.
//   3) Anything flagged but not nameable is "Negative tone".

import { ESCALATION_CUE_LABELS, PRICE_CUE_LABEL, type CallConcern, type Sentiment } from "./sentiment";
import type { CallReason } from "./reasons";

export interface CallAlertTitle {
  emoji: string; // Slack emoji shortcode (severity marker), kept separate from the heading text
  heading: string; // short heading text, no dashes, no emoji (house comms style)
  concern: CallConcern;
}

const TITLES: Record<CallConcern, { emoji: string; heading: string }> = {
  frustration: { emoji: ":rotating_light:", heading: "Frustrated caller" },
  price_objection: { emoji: ":warning:", heading: "Price objection" },
  cancellation_risk: { emoji: ":warning:", heading: "Possible cancellation" },
  complaint: { emoji: ":warning:", heading: "Complaint" },
  damage: { emoji: ":warning:", heading: "Damage reported" },
  billing: { emoji: ":warning:", heading: "Billing concern" },
  delivery_problem: { emoji: ":warning:", heading: "Delivery problem" },
  negative_tone: { emoji: ":telephone_receiver:", heading: "Negative tone" },
};

/** Did the deterministic cues pick up genuine anger (vs. a calm but negative call)? Pure. */
export function isEscalationSentiment(s: Sentiment): boolean {
  if (!s.isNegative) return false;
  if (s.method === "llm") return s.concern === "frustration";
  return s.reasons.some((r) => ESCALATION_CUE_LABELS.has(r));
}

/** The main concern of a flagged call. Pure. */
export function callConcern(s: Sentiment, reason?: CallReason | null): CallConcern {
  if (s.method === "llm" && s.concern) return s.concern;
  if (s.method === "heuristic" && isEscalationSentiment(s)) return "frustration";
  if (s.reasons.includes(PRICE_CUE_LABEL)) return "price_objection";
  if (s.reasons.includes("cancel")) return "cancellation_risk";
  switch (reason) {
    case "CANCELLATION":
      return "cancellation_risk";
    case "DAMAGE":
      return "damage";
    case "COMPLAINT":
      return "complaint";
    case "BILLING":
    case "PAYMENT":
      return "billing";
    case "DELIVERY_STATUS":
    case "PICKUP_STATUS":
      return "delivery_problem";
    default:
      break;
  }
  if (s.reasons.includes("wants refund")) return "billing";
  if (s.reasons.includes("complaint")) return "complaint";
  return "negative_tone";
}

/** The honest heading for a fired call alert, derived from the concern. */
export function callAlertTitle(sentiment: Sentiment, reason?: CallReason | null): CallAlertTitle {
  const concern = callConcern(sentiment, reason);
  return { ...TITLES[concern], concern };
}
