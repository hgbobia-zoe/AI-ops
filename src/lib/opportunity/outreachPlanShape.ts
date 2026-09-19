// Guided Outreach Plan — PURE shapes shared by the server engine (outreachPlan.ts) and the client
// walk-through (OutreachPlanView). No DB import. The plan turns a radar recommendation into a coached,
// step-by-step outreach playbook so someone who is NOT a natural at sales / cold outreach can follow it
// and actually do it. FACTS only: it never invents a contact, a date, or a claim about Zoe.

export type PlanChannel = "research" | "email" | "call" | "voicemail" | "text" | "linkedin";
export const PLAN_CHANNEL_LABEL: Record<PlanChannel, string> = {
  research: "Prep", email: "Email", call: "Call", voicemail: "Voicemail", text: "Text", linkedin: "LinkedIn",
};

export interface PlanStep {
  id: string;
  title: string; // "Step 1 — Do your homework"
  channel: PlanChannel;
  when: string; // "Before you reach out" · "Day 1" · "Day 3"
  goal: string; // one line: what this step is for
  actions: string[]; // concrete to-dos
  script: string | null; // copy-paste script (email/call/voicemail), or null for a prep step
  coaching: string[]; // plain do/don't tips written for a nervous beginner
  successSignal: string; // how you know it worked / when to move on
}

export interface Objection {
  id: string;
  trigger: string; // what they say
  response: string; // what you say back
  why: string; // the coaching reason it works
}

// Where the person is in actually running the plan (persisted).
export type PlanStatus = "planned" | "working" | "responded" | "quote_agreed" | "closed";
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  planned: "Not started", working: "Working it", responded: "They responded", quote_agreed: "Quote agreed", closed: "Closed / passed",
};
export const PLAN_STATUS_ORDER: PlanStatus[] = ["planned", "working", "responded", "quote_agreed", "closed"];

export interface OutreachPlan {
  opportunityId: string;
  opportunityName: string;
  targetName: string; // who you're contacting (or "the organizer" when unknown)
  targetLabel: string; // their role, e.g. "Event planner"
  hasContact: boolean; // do we actually have an email/phone to use
  strategyHeadline: string; // the one-line game plan
  whyNow: string; // timing read
  angle: string; // the approach for THIS opportunity type (awarded / procurement / event)
  channelPlan: string; // "Email first, call if no reply in 3 days"
  steps: PlanStep[];
  objections: Objection[];
  source: "template" | "ai";
  aiAvailable: boolean;
}

export interface PlanState {
  status: PlanStatus;
  done: Record<string, boolean>; // stepId -> completed
  notes: string;
  updatedAt: string | null;
}

export function emptyPlanState(): PlanState {
  return { status: "planned", done: {}, notes: "", updatedAt: null };
}
