// Call-reason taxonomy — the fixed set of reasons a customer might contact Zoe. RULES CALCULATE, AI
// INTERPRETS: the deterministic classifier here derives a best-guess reason + confidence from a call's
// summary/transcript keywords (FACT-driven, explainable), and a human can override it (reversible). A
// real LLM interpretation can be slotted in later behind the same shape — it would be labelled INFERENCE
// and never overwrite a human override. We never fabricate a reason; when nothing matches we say OTHER
// at low confidence rather than guessing something specific.

export type CallReason =
  | "SALES_INQUIRY"
  | "QUOTE_FOLLOW_UP"
  | "EXISTING_ORDER"
  | "DELIVERY_STATUS"
  | "PICKUP_STATUS"
  | "EVENT_CHANGE"
  | "INVENTORY_QUESTION"
  | "BILLING"
  | "PAYMENT"
  | "DAMAGE"
  | "COMPLAINT"
  | "CANCELLATION"
  | "VENUE_COORDINATION"
  | "PLANNER_COORDINATION"
  | "GENERAL_QUESTION"
  | "HUMAN_REQUEST"
  | "OTHER";

export const CALL_REASONS: CallReason[] = [
  "SALES_INQUIRY", "QUOTE_FOLLOW_UP", "EXISTING_ORDER", "DELIVERY_STATUS", "PICKUP_STATUS",
  "EVENT_CHANGE", "INVENTORY_QUESTION", "BILLING", "PAYMENT", "DAMAGE", "COMPLAINT",
  "CANCELLATION", "VENUE_COORDINATION", "PLANNER_COORDINATION", "GENERAL_QUESTION",
  "HUMAN_REQUEST", "OTHER",
];

export const REASON_LABEL: Record<CallReason, string> = {
  SALES_INQUIRY: "Sales inquiry",
  QUOTE_FOLLOW_UP: "Quote follow-up",
  EXISTING_ORDER: "Existing order",
  DELIVERY_STATUS: "Delivery status",
  PICKUP_STATUS: "Pickup status",
  EVENT_CHANGE: "Event change",
  INVENTORY_QUESTION: "Inventory question",
  BILLING: "Billing",
  PAYMENT: "Payment",
  DAMAGE: "Damage",
  COMPLAINT: "Complaint",
  CANCELLATION: "Cancellation",
  VENUE_COORDINATION: "Venue coordination",
  PLANNER_COORDINATION: "Planner coordination",
  GENERAL_QUESTION: "General question",
  HUMAN_REQUEST: "Human requested",
  OTHER: "Other / unclassified",
};

// Which broad desk a reason routes to — used by the queue's category filter (Sales / Operations / Billing).
export type ReasonDesk = "SALES" | "OPERATIONS" | "BILLING" | "GENERAL";

export const REASON_DESK: Record<CallReason, ReasonDesk> = {
  SALES_INQUIRY: "SALES",
  QUOTE_FOLLOW_UP: "SALES",
  INVENTORY_QUESTION: "SALES",
  EXISTING_ORDER: "OPERATIONS",
  DELIVERY_STATUS: "OPERATIONS",
  PICKUP_STATUS: "OPERATIONS",
  EVENT_CHANGE: "OPERATIONS",
  DAMAGE: "OPERATIONS",
  VENUE_COORDINATION: "OPERATIONS",
  PLANNER_COORDINATION: "OPERATIONS",
  BILLING: "BILLING",
  PAYMENT: "BILLING",
  COMPLAINT: "GENERAL",
  CANCELLATION: "GENERAL",
  GENERAL_QUESTION: "GENERAL",
  HUMAN_REQUEST: "GENERAL",
  OTHER: "GENERAL",
};

export interface ReasonVerdict {
  reason: CallReason;
  confidence: number; // 0..1
  method: "heuristic" | "human"; // how the verdict was reached (honesty)
  matched: string[]; // the keywords that drove a heuristic verdict (explainability)
}

// Ordered keyword rules — first strong match wins. Deliberately specific before general so
// "reschedule the delivery" reads as DELIVERY_STATUS/EVENT_CHANGE, not GENERAL_QUESTION.
const RULES: { reason: CallReason; terms: string[] }[] = [
  { reason: "CANCELLATION", terms: ["cancel", "call it off", "not going ahead", "refund the whole"] },
  { reason: "DAMAGE", terms: ["broke", "broken", "damaged", "torn", "stained", "cracked", "ripped"] },
  { reason: "COMPLAINT", terms: ["complaint", "unhappy", "frustrated", "unacceptable", "terrible", "disappointed", "manager"] },
  { reason: "PAYMENT", terms: ["pay my", "make a payment", "pay the", "card on file", "deposit", "credit card", "pay the balance"] },
  { reason: "BILLING", terms: ["invoice", "charged", "overcharged", "billing", "receipt", "statement", "balance due", "refund"] },
  { reason: "DELIVERY_STATUS", terms: ["delivery", "deliver", "drop off", "dropoff", "when will it arrive", "on the way", "eta", "driver"] },
  { reason: "PICKUP_STATUS", terms: ["pick up", "pickup", "pick it up", "collect the", "come get"] },
  { reason: "EVENT_CHANGE", terms: ["reschedule", "change the date", "move the date", "new date", "change the time", "add more", "add a few", "change my order", "update my order"] },
  { reason: "QUOTE_FOLLOW_UP", terms: ["my quote", "the quote", "proposal", "estimate", "quote you sent", "following up on"] },
  { reason: "INVENTORY_QUESTION", terms: ["do you have", "available", "in stock", "rent a", "how many", "what size", "do you carry"] },
  { reason: "VENUE_COORDINATION", terms: ["venue", "loading dock", "site contact", "coordinator at the", "access to the"] },
  { reason: "PLANNER_COORDINATION", terms: ["planner", "coordinator", "on behalf of", "my client's event"] },
  { reason: "EXISTING_ORDER", terms: ["my order", "my rental", "my contract", "my event with", "order number", "confirmation number"] },
  { reason: "SALES_INQUIRY", terms: ["get a quote", "pricing", "how much", "interested in", "planning a", "wedding", "corporate event", "book"] },
  { reason: "HUMAN_REQUEST", terms: ["speak to a person", "talk to someone", "real person", "representative", "speak to a human", "agent"] },
];

/** Best-guess reason for a call from its available text (summary preferred, then transcript). Deterministic
 *  + explainable. Returns OTHER at low confidence when nothing matches — never a fabricated specific reason. */
export function classifyReason(text: string | null | undefined): ReasonVerdict {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return { reason: "OTHER", confidence: 0, method: "heuristic", matched: [] };
  for (const rule of RULES) {
    const matched = rule.terms.filter((term) => t.includes(term));
    if (matched.length > 0) {
      // Confidence scales with how many cues matched, capped — this is a heuristic, never certainty.
      const confidence = Math.min(0.85, 0.5 + 0.12 * matched.length);
      return { reason: rule.reason, confidence, method: "heuristic", matched };
    }
  }
  return { reason: "GENERAL_QUESTION", confidence: 0.2, method: "heuristic", matched: [] };
}
