// Follow-up brief (Phase 9) — the 15-second briefing a rep reads before reaching out. Zoe ALWAYS
// follows a call with a text and an email, so each state carries three ready pieces: a call brief
// (opening, the one key question, what to watch for), a text draft, and an email draft. RULES CALCULATE:
// everything is keyed to the customer's current STATE (evidence-driven). Premium methodology baked in —
// discovery before discounting, verify before promising. Deterministic + instant; no AI on the path.
// Drafts are starting points for the rep to edit — nothing sends automatically.

import type { CustomerState } from "./state";

export interface CallBriefTemplate {
  blocker: string | null; // the likely blocker, if the state implies one (INFERENCE)
  opening: string; // a natural opener ({first} = customer first name)
  primaryQuestion: string; // the single most important question
  watchFor: string[]; // signals to listen for
  textDraft: string; // ready follow-up SMS (short, no signature)
  email: { subject: string; body: string }; // ready follow-up email
}

const BRIEF: Record<CustomerState, CallBriefTemplate> = {
  NEW: {
    blocker: null,
    opening: "Hi {first}, it's Zoe Events — I wanted to make sure your quote reached you and answer anything before you decide.",
    primaryQuestion: "What's most important to you in pulling this event together?",
    watchFor: ["Budget signals", "Decision timeline", "Who else is involved in the decision"],
    textDraft: "Hi {first}, it's Zoe Events! Just sent your quote over — happy to walk through anything or tweak it to fit your event. What questions can I answer?",
    email: { subject: "Your Zoe Events quote", body: "Hi {first},\n\nThanks for considering Zoe Events! Your quote is in your inbox — I'd love to make sure it fits exactly what you're picturing.\n\nWhat's most important to you for this event? Happy to adjust anything or hop on a quick call.\n\nBest,\nZoe Events" },
  },
  CONTACTED: {
    blocker: null,
    opening: "Hi {first}, checking you got the quote and seeing if anything needs clarifying.",
    primaryQuestion: "Did the quote cover everything you were picturing, or is anything missing?",
    watchFor: ["Unstated needs", "Hesitation on scope", "Timeline pressure"],
    textDraft: "Hi {first}! Following up on your Zoe Events quote — did it cover everything you had in mind, or is anything missing?",
    email: { subject: "Following up on your quote", body: "Hi {first},\n\nJust following up on the quote I sent — I want to be sure it captures everything you're planning.\n\nIs there anything you'd add, change, or have questions about? I'm glad to help.\n\nBest,\nZoe Events" },
  },
  QUOTED: {
    blocker: "Unknown — no reply yet to reveal it",
    opening: "Hi {first}, following up on your quote — wanted to see where your thinking is.",
    primaryQuestion: "Where are you in your decision, and what would help you feel confident moving forward?",
    watchFor: ["The real hesitation", "Comparison signals", "Readiness cues"],
    textDraft: "Hi {first}, checking in on your Zoe Events quote — where's your thinking? Happy to answer anything that would help you decide.",
    email: { subject: "Checking in on your event", body: "Hi {first},\n\nWanted to check in on the quote for your event. Where are you in your planning?\n\nIf anything's holding you up or you'd like to talk through options, I'm here to help.\n\nBest,\nZoe Events" },
  },
  EVALUATING: {
    blocker: "They're weighing options",
    opening: "Hi {first}, I know you're weighing this — happy to help you get to a clear decision.",
    primaryQuestion: "What are the main things you're weighing right now?",
    watchFor: ["Decision criteria", "Other vendors", "What 'confident' looks like to them"],
    textDraft: "Hi {first}! I know you're weighing your options — what are the main things on your list? Happy to help you compare apples to apples.",
    email: { subject: "Here to help you decide", body: "Hi {first},\n\nI know you're weighing a few things for your event. What matters most to you as you decide?\n\nHappy to lay out exactly what's included so you can compare with confidence.\n\nBest,\nZoe Events" },
  },
  PRICE_OBJECTION: {
    blocker: "Price feels higher than expected",
    opening: "Hi {first}, thanks for being upfront about the budget — let me make sure the quote reflects what actually matters for your event.",
    primaryQuestion: "Is it the total that's the concern, or the value you're seeing for it?",
    watchFor: ["Whether price is the REAL blocker or a proxy", "Scope they'd trade", "What reliability is worth to them"],
    textDraft: "Hi {first}, thanks for being honest about budget. Let's make the quote fit — want me to show a couple of options at different price points?",
    email: { subject: "Making your quote work for your budget", body: "Hi {first},\n\nThanks for being upfront about the budget. I'd rather right-size the quote than have you overpay for things that don't matter to your event.\n\nWould it help if I put together a couple of options at different price points? Let me know what feels comfortable.\n\nBest,\nZoe Events" },
  },
  LOGISTICS_OBJECTION: {
    blocker: "A logistics/timing concern",
    opening: "Hi {first}, let's nail down the logistics so you know exactly how the day runs.",
    primaryQuestion: "Walk me through the timing and access at your venue — when do you need us there and out?",
    watchFor: ["Delivery/pickup windows", "Site access constraints", "Anything I must verify before promising"],
    textDraft: "Hi {first}! Let's lock the logistics — what are your delivery and pickup windows at the venue? I'll confirm we can hit them.",
    email: { subject: "Locking down your event logistics", body: "Hi {first},\n\nLet's nail down the day-of logistics so there are no surprises. When do you need us on site, and when do we need to be out?\n\nSend me the venue's access details and I'll confirm everything on our end.\n\nBest,\nZoe Events" },
  },
  PRODUCT_UNCERTAINTY: {
    blocker: "Unsure what they need",
    opening: "Hi {first}, let's make sure we spec exactly what fits your event — no more, no less.",
    primaryQuestion: "Tell me about the space and guest count — how do you want it to feel?",
    watchFor: ["Guest count", "Indoor/outdoor", "Style they're going for"],
    textDraft: "Hi {first}! Want to make sure we spec the right setup — roughly how many guests, and indoor or outdoor? I'll tailor the quote to fit.",
    email: { subject: "Getting your setup just right", body: "Hi {first},\n\nI want to make sure we spec exactly what your event needs. A few quick things help: guest count, indoor or outdoor, and the feel you're going for.\n\nSend those over and I'll tailor the quote to match.\n\nBest,\nZoe Events" },
  },
  COMPETITOR_COMPARISON: {
    blocker: "Comparing other vendors",
    opening: "Hi {first}, totally reasonable to compare — I want to make sure you're comparing on the things that actually matter on event day.",
    primaryQuestion: "What are the main things you're comparing between the vendors you're considering?",
    watchFor: ["What they value most", "Where competitors look cheaper (and why)", "Reliability/execution concerns"],
    textDraft: "Hi {first}! Totally fair to compare vendors. What are you weighing most? I'll be straight with you on where we're strong and what to watch for.",
    email: { subject: "Comparing your options", body: "Hi {first},\n\nComparing vendors is smart — I just want to make sure you're comparing on what actually matters on event day: reliability, setup, and no surprises.\n\nWhat are the main things on your list? I'll give you an honest read.\n\nBest,\nZoe Events" },
  },
  READY_TO_BOOK: {
    blocker: null,
    opening: "Hi {first}, great — let's get you locked in so your date and items are secured.",
    primaryQuestion: "Shall I send the contract now so we hold everything for your date?",
    watchFor: ["Any last hesitation", "Deposit readiness", "Delivery details to confirm"],
    textDraft: "Hi {first}! Ready to lock you in — want me to send the contract now so we hold your date and everything on the quote?",
    email: { subject: "Let's secure your date", body: "Hi {first},\n\nExcited to get you booked! I can send the contract over now so your date and all your items are secured.\n\nJust reply and I'll get it right out to you.\n\nBest,\nZoe Events" },
  },
  WON: { blocker: null, opening: "", primaryQuestion: "", watchFor: [], textDraft: "", email: { subject: "", body: "" } },
  LOST: { blocker: null, opening: "", primaryQuestion: "", watchFor: [], textDraft: "", email: { subject: "", body: "" } },
  DORMANT: {
    blocker: "Gone quiet after prior attempts",
    opening: "Hi {first}, I don't want to crowd you — just checking whether this event is still happening on your end.",
    primaryQuestion: "Is this still on your radar, or have your plans changed?",
    watchFor: ["Whether it's alive at all", "A cleaner reason it stalled", "Permission for a lighter cadence"],
    textDraft: "Hi {first}, no pressure at all — is your event still on? Happy to pick back up whenever the timing's right.",
    email: { subject: "Still planning your event?", body: "Hi {first},\n\nI don't want to crowd your inbox — just checking whether your event is still in the works.\n\nIf it is, I'm glad to pick right back up. If plans changed, no worries at all — just let me know.\n\nBest,\nZoe Events" },
  },
};

/** The state-keyed brief, with the customer's first name interpolated across all three pieces. */
export function callBriefFor(state: CustomerState, name: string): CallBriefTemplate {
  const first = (name || "").trim().split(/\s+/)[0] || "there";
  const t = BRIEF[state];
  const sub = (s: string): string => s.replace(/\{first\}/g, first);
  return {
    ...t,
    opening: sub(t.opening),
    primaryQuestion: sub(t.primaryQuestion),
    textDraft: sub(t.textDraft),
    email: { subject: sub(t.email.subject), body: sub(t.email.body) },
  };
}
