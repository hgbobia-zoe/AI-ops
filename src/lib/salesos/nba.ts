// Next-Best-Action v2 (Phase 6) — from the customer's STATE (evidence-driven) to the single best thing
// the rep should do next, with the objective and an explicit "do not". RULES CALCULATE: the state→action
// mapping is deterministic and encodes Zoe's premium methodology (never discount-first). Priority blends
// the action's base urgency with deal value and how recently the customer engaged.

import type { CustomerState } from "./state";

export type NbaAction =
  | "CALL_NOW"
  | "SEND_SMS"
  | "WAIT"
  | "ASK_DISCOVERY"
  | "FOLLOW_UP"
  | "HANDLE_OBJECTION"
  | "VERIFY_AVAILABILITY"
  | "REVIEW_QUOTE"
  | "CONFIRM_LOGISTICS"
  | "CLOSE"
  | "ESCALATE"
  | "NO_ACTION";

export const NBA_LABEL: Record<NbaAction, string> = {
  CALL_NOW: "Call now",
  SEND_SMS: "Send a text",
  WAIT: "Wait",
  ASK_DISCOVERY: "Ask discovery questions",
  FOLLOW_UP: "Follow up",
  HANDLE_OBJECTION: "Handle the objection",
  VERIFY_AVAILABILITY: "Verify availability",
  REVIEW_QUOTE: "Review the quote",
  CONFIRM_LOGISTICS: "Confirm logistics",
  CLOSE: "Close",
  ESCALATE: "Escalate",
  NO_ACTION: "No action needed",
};

export interface NextBestAction {
  action: NbaAction;
  objective: string; // what the rep should accomplish
  doNot: string | null; // what they must NOT do
  reason: string; // why now (traceable to state/evidence)
}

// State → action mapping. Encodes the methodology: objections are discovered, not discounted.
const MAP: Record<CustomerState, Omit<NextBestAction, "reason">> = {
  NEW: { action: "SEND_SMS", objective: "Get the quote in front of them and open the conversation.", doNot: "Don't wait — nothing moves until it's sent." },
  CONTACTED: { action: "FOLLOW_UP", objective: "Confirm they received the quote and invite questions.", doNot: "Don't push hard yet — it's early." },
  QUOTED: { action: "FOLLOW_UP", objective: "Re-open the conversation and surface any hesitation.", doNot: "Don't assume silence means no." },
  EVALUATING: { action: "CALL_NOW", objective: "Understand their decision criteria and what they're weighing.", doNot: "Don't discount before you know the real question." },
  PRICE_OBJECTION: { action: "HANDLE_OBJECTION", objective: "Find out whether price is the true blocker, then reframe value (reliability, execution).", doNot: "Do NOT reflexively discount — Zoe sells on execution, not price." },
  LOGISTICS_OBJECTION: { action: "CONFIRM_LOGISTICS", objective: "Clarify the logistics concern (timing/access/delivery) and resolve it concretely.", doNot: "Don't promise a time or availability you can't verify." },
  PRODUCT_UNCERTAINTY: { action: "ASK_DISCOVERY", objective: "Clarify what they need and match it to the right products.", doNot: "Don't oversell items that don't fit the event." },
  COMPETITOR_COMPARISON: { action: "CALL_NOW", objective: "Learn what they're comparing and establish Zoe's operational advantage.", doNot: "Don't drop price to 'win' — differentiate on reliability first." },
  READY_TO_BOOK: { action: "CLOSE", objective: "Confirm the details and get the contract signed / deposit in.", doNot: "Don't introduce new options that stall the decision." },
  WON: { action: "NO_ACTION", objective: "Booked — hand off to operations.", doNot: null },
  LOST: { action: "NO_ACTION", objective: "Closed lost — capture the reason for the autopsy.", doNot: null },
  DORMANT: { action: "FOLLOW_UP", objective: "One respectful re-engagement, or close it out cleanly.", doNot: "Don't repeat the same chase that already went unanswered." },
};

const BASE_PRIORITY: Record<NbaAction, number> = {
  CLOSE: 55,
  HANDLE_OBJECTION: 50,
  CALL_NOW: 48,
  CONFIRM_LOGISTICS: 45,
  VERIFY_AVAILABILITY: 45,
  ASK_DISCOVERY: 35,
  REVIEW_QUOTE: 35,
  SEND_SMS: 40,
  FOLLOW_UP: 30,
  ESCALATE: 60,
  WAIT: 5,
  NO_ACTION: 0,
};

export interface NbaInputs {
  state: CustomerState;
  value: number | null; // potential $
  daysToEvent: number | null;
  repliedMinutesAgo: number | null; // minutes since the customer last replied (null if never)
}

export interface NbaResult extends NextBestAction {
  priority: number;
  factors: { label: string; points: number }[];
}

function valuePoints(v: number | null): number {
  if (v == null || v <= 0) return 0;
  if (v >= 10000) return 25;
  if (v >= 5000) return 16;
  if (v >= 2000) return 9;
  return 3;
}

/** The recommended next action + an explainable priority. A high-value lead that JUST replied outranks
 *  a small one sitting untouched — but the ranking is transparent, not hard-coded to value alone. */
export function nextBestAction(i: NbaInputs): NbaResult {
  const m = MAP[i.state];
  const factors: { label: string; points: number }[] = [{ label: NBA_LABEL[m.action], points: BASE_PRIORITY[m.action] }];

  const vp = valuePoints(i.value);
  if (vp > 0) factors.push({ label: "Deal size", points: vp });

  // A fresh customer reply is the strongest "act now" signal.
  if (i.repliedMinutesAgo != null) {
    const rp = i.repliedMinutesAgo <= 30 ? 30 : i.repliedMinutesAgo <= 180 ? 20 : i.repliedMinutesAgo <= 1440 ? 10 : 0;
    if (rp > 0) factors.push({ label: i.repliedMinutesAgo <= 30 ? "Just replied" : "Replied recently", points: rp });
  }

  if (i.daysToEvent != null && i.daysToEvent >= 0 && i.daysToEvent <= 14) {
    factors.push({ label: i.daysToEvent <= 7 ? "Event this week" : "Event soon", points: i.daysToEvent <= 7 ? 20 : 12 });
  }

  const priority = factors.reduce((n, f) => n + f.points, 0);
  const reason = `State: ${i.state}${i.repliedMinutesAgo != null && i.repliedMinutesAgo <= 60 ? ` · replied ${i.repliedMinutesAgo}m ago` : ""}.`;
  return { ...m, reason, priority, factors };
}
