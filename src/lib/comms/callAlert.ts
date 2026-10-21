// Title for the customer-call Slack alert. RULES CALCULATE, AI INTERPRETS + honest-when-unobservable:
// the heading is a PURE function of what the system actually detected, never a blanket label. The alert
// only fires when the call sentiment is negative, so every title here describes a genuinely flagged call;
// this helper decides WHICH honest heading it gets.
//
// What the system can really tell apart:
//   • Genuine frustration / escalation — the emotional cues (furious, unacceptable, refund, "never again",
//     profanity, shouting) the sentiment heuristic scores, or an LLM read that flags real unhappiness.
//     This keeps the urgent :rotating_light: "Frustrated caller" treatment.
//   • A negative-tone call that is really a specific operational signal the deterministic reason
//     classifier can name (a reported damage, a cancellation, a billing concern, a complaint) — titled
//     for what it is, not overstated as anger.
//   • Anything else we flagged but can't name more specifically → the neutral "Call insight".
//
// These are the ONLY distinctions the current heuristics support. We do not invent finer categories.

import { ESCALATION_CUE_LABELS, type Sentiment } from "./sentiment";
import type { CallReason } from "./reasons";

export interface CallAlertTitle {
  emoji: string; // Slack emoji shortcode (severity marker), kept separate from the heading text
  heading: string; // short heading text — no dashes, no emoji (house comms style)
}

/** Does this sentiment reflect a genuinely frustrated / escalation caller (vs. a negative-tone but not
 *  angry operational report)? Pure. Heuristic verdicts are judged by their emotional cue labels; an LLM
 *  "negative" verdict is treated as genuine frustration because the model is prompted to flag only that. */
export function isEscalationSentiment(s: Sentiment): boolean {
  if (!s.isNegative) return false;
  if (s.method === "llm") return true;
  return s.reasons.some((r) => ESCALATION_CUE_LABELS.has(r));
}

/** The honest heading for a fired call alert, derived purely from the classification. */
export function callAlertTitle(sentiment: Sentiment, reason?: CallReason | null): CallAlertTitle {
  // 1) Genuine frustration / escalation keeps the existing urgent treatment.
  if (isEscalationSentiment(sentiment)) {
    return { emoji: ":rotating_light:", heading: "Frustrated caller" };
  }
  // 2) A negative-tone call the reason classifier can name specifically — honest, not overstated.
  switch (reason) {
    case "CANCELLATION":
      return { emoji: ":warning:", heading: "Possible cancellation" };
    case "DAMAGE":
      return { emoji: ":warning:", heading: "Damage reported" };
    case "COMPLAINT":
      return { emoji: ":warning:", heading: "Complaint" };
    case "BILLING":
    case "PAYMENT":
      return { emoji: ":warning:", heading: "Billing concern" };
    default:
      // 3) Flagged, but nothing more specific detected — stay neutral and honest.
      return { emoji: ":telephone_receiver:", heading: "Call insight" };
  }
}
