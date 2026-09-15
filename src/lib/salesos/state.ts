// Customer state machine (Phase 5) — the customer's current state, EVIDENCE-DRIVEN. RULES CALCULATE
// the states we can know for certain (FACT: signed = won, lost status = lost, no quote sent = new,
// long silence = dormant); the AI INTERPRETS a customer's latest reply into a finer state (INFERENCE,
// with confidence + the quote it rests on). Never invents state: with no evidence it stays at the
// deterministic FACT state, and an unparseable/model-down response changes nothing.

export type CustomerState =
  | "NEW"
  | "CONTACTED"
  | "QUOTED"
  | "EVALUATING"
  | "PRICE_OBJECTION"
  | "LOGISTICS_OBJECTION"
  | "PRODUCT_UNCERTAINTY"
  | "COMPETITOR_COMPARISON"
  | "READY_TO_BOOK"
  | "WON"
  | "LOST"
  | "DORMANT";

export const STATE_LABEL: Record<CustomerState, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUOTED: "Quoted",
  EVALUATING: "Evaluating",
  PRICE_OBJECTION: "Price objection",
  LOGISTICS_OBJECTION: "Logistics question",
  PRODUCT_UNCERTAINTY: "Product uncertainty",
  COMPETITOR_COMPARISON: "Comparing vendors",
  READY_TO_BOOK: "Ready to book",
  WON: "Won",
  LOST: "Lost",
  DORMANT: "Dormant",
};

export const ALL_CUSTOMER_STATES: CustomerState[] = Object.keys(STATE_LABEL) as CustomerState[];

export type StateSource = "goodshuffle" | "inbound_reply" | "inactivity" | "derived" | "notes";

export interface ResolvedState {
  state: CustomerState;
  confidence: number; // 0..1
  evidence: string; // the fact or quote behind it
  source: StateSource;
  reason: string; // FACT/INFERENCE-labelled explanation
}

/** Inputs the deterministic resolver needs — all FACTs we already hold. */
export interface StateFacts {
  signed: boolean;
  statusLabel: string | null; // Goodshuffle status
  everSent: boolean; // quote went to the client
  daysSinceLastActivity: number | null; // days since the most recent touch either way
}

const LOST_RE = /(lost|cancel|dead)/i;
const DORMANT_DAYS = 21;

/** The state we can assert from FACTS alone (no AI). Always defined. */
export function deterministicState(f: StateFacts): ResolvedState {
  if (LOST_RE.test(f.statusLabel ?? "")) {
    return { state: "LOST", confidence: 1, evidence: `Goodshuffle status "${f.statusLabel}"`, source: "goodshuffle", reason: "FACT: Goodshuffle marks this lost/cancelled." };
  }
  if (f.signed) {
    return { state: "WON", confidence: 1, evidence: `Goodshuffle status "${f.statusLabel ?? "signed"}"`, source: "goodshuffle", reason: "FACT: contract is signed in Goodshuffle." };
  }
  if (!f.everSent) {
    return { state: "NEW", confidence: 0.9, evidence: "No quote sent yet", source: "goodshuffle", reason: "FACT: the quote hasn't gone to the client." };
  }
  if (f.daysSinceLastActivity != null && f.daysSinceLastActivity >= DORMANT_DAYS) {
    return { state: "DORMANT", confidence: 0.75, evidence: `${f.daysSinceLastActivity} days since last activity`, source: "inactivity", reason: `INFERENCE: no contact in ${f.daysSinceLastActivity} days — likely gone cold.` };
  }
  return { state: "QUOTED", confidence: 0.7, evidence: "Quote sent, awaiting a decision", source: "goodshuffle", reason: "FACT: quote sent; no reply yet to refine the state." };
}

/** A classification of ONE inbound reply (from the AI). Kept pure so it can be validated + tested. */
export interface ReplyClassification {
  state: CustomerState;
  confidence: number;
  evidenceQuote: string; // the customer's words the state rests on
}

/** Fold an inbound-reply classification over the deterministic base. A signed/lost FACT always wins;
 *  otherwise a confident reply classification refines the state (INFERENCE). */
export function foldReply(base: ResolvedState, reply: ReplyClassification | null): ResolvedState {
  if (base.state === "WON" || base.state === "LOST") return base; // FACT beats inference
  if (!reply || reply.confidence < 0.4) return base;
  return {
    state: reply.state,
    confidence: reply.confidence,
    evidence: reply.evidenceQuote,
    source: "inbound_reply",
    reason: `INFERENCE: from the customer's reply — "${reply.evidenceQuote}".`,
  };
}
