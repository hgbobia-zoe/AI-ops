// Call brief (Phase 9) — the 15-second briefing a rep reads before dialing. RULES CALCULATE: the
// opening, the single most important question, what to watch for, and the likely blocker are keyed to
// the customer's current STATE (which is itself evidence-driven). Zoe's premium methodology is baked in
// — discovery before discounting, verify before promising. Deterministic + instant; no AI on the path.

import type { CustomerState } from "./state";

export interface CallBriefTemplate {
  blocker: string | null; // the likely blocker, if the state implies one (INFERENCE)
  opening: string; // a natural opener ({first} = customer first name)
  primaryQuestion: string; // the single most important question
  watchFor: string[]; // signals to listen for
}

const BRIEF: Record<CustomerState, CallBriefTemplate> = {
  NEW: {
    blocker: null,
    opening: "Hi {first}, it's Zoe Events — I wanted to make sure your quote reached you and answer anything before you decide.",
    primaryQuestion: "What's most important to you in pulling this event together?",
    watchFor: ["Budget signals", "Decision timeline", "Who else is involved in the decision"],
  },
  CONTACTED: {
    blocker: null,
    opening: "Hi {first}, checking you got the quote and seeing if anything needs clarifying.",
    primaryQuestion: "Did the quote cover everything you were picturing, or is anything missing?",
    watchFor: ["Unstated needs", "Hesitation on scope", "Timeline pressure"],
  },
  QUOTED: {
    blocker: "Unknown — no reply yet to reveal it",
    opening: "Hi {first}, following up on your quote — wanted to see where your thinking is.",
    primaryQuestion: "Where are you in your decision, and what would help you feel confident moving forward?",
    watchFor: ["The real hesitation", "Comparison signals", "Readiness cues"],
  },
  EVALUATING: {
    blocker: "They're weighing options",
    opening: "Hi {first}, I know you're weighing this — happy to help you get to a clear decision.",
    primaryQuestion: "What are the main things you're weighing right now?",
    watchFor: ["Decision criteria", "Other vendors", "What 'confident' looks like to them"],
  },
  PRICE_OBJECTION: {
    blocker: "Price feels higher than expected",
    opening: "Hi {first}, thanks for being upfront about the budget — let me make sure the quote reflects what actually matters for your event.",
    primaryQuestion: "Is it the total that's the concern, or the value you're seeing for it?",
    watchFor: ["Whether price is the REAL blocker or a proxy", "Scope they'd trade", "What reliability is worth to them"],
  },
  LOGISTICS_OBJECTION: {
    blocker: "A logistics/timing concern",
    opening: "Hi {first}, let's nail down the logistics so you know exactly how the day runs.",
    primaryQuestion: "Walk me through the timing and access at your venue — when do you need us there and out?",
    watchFor: ["Delivery/pickup windows", "Site access constraints", "Anything I must verify before promising"],
  },
  PRODUCT_UNCERTAINTY: {
    blocker: "Unsure what they need",
    opening: "Hi {first}, let's make sure we spec exactly what fits your event — no more, no less.",
    primaryQuestion: "Tell me about the space and guest count — how do you want it to feel?",
    watchFor: ["Guest count", "Indoor/outdoor", "Style they're going for"],
  },
  COMPETITOR_COMPARISON: {
    blocker: "Comparing other vendors",
    opening: "Hi {first}, totally reasonable to compare — I want to make sure you're comparing on the things that actually matter on event day.",
    primaryQuestion: "What are the main things you're comparing between the vendors you're considering?",
    watchFor: ["What they value most", "Where competitors look cheaper (and why)", "Reliability/execution concerns"],
  },
  READY_TO_BOOK: {
    blocker: null,
    opening: "Hi {first}, great — let's get you locked in so your date and items are secured.",
    primaryQuestion: "Shall I send the contract now so we hold everything for your date?",
    watchFor: ["Any last hesitation", "Deposit readiness", "Delivery details to confirm"],
  },
  WON: { blocker: null, opening: "", primaryQuestion: "", watchFor: [] },
  LOST: { blocker: null, opening: "", primaryQuestion: "", watchFor: [] },
  DORMANT: {
    blocker: "Gone quiet after prior attempts",
    opening: "Hi {first}, I don't want to crowd you — just checking whether this event is still happening on your end.",
    primaryQuestion: "Is this still on your radar, or have your plans changed?",
    watchFor: ["Whether it's alive at all", "A cleaner reason it stalled", "Permission for a lighter cadence"],
  },
};

/** The state-keyed brief, with the customer's first name interpolated. */
export function callBriefFor(state: CustomerState, name: string): CallBriefTemplate {
  const first = (name || "").trim().split(/\s+/)[0] || "there";
  const t = BRIEF[state];
  return { ...t, opening: t.opening.replace(/\{first\}/g, first), primaryQuestion: t.primaryQuestion };
}
