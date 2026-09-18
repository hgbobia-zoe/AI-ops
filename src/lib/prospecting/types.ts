// Prospecting — the cold-outreach motion that runs BEFORE Goodshuffle. Goodshuffle is reserved for
// CONVERSION (a real quote), reached only once a prospect responds. Types for tiering, cadences, and
// the rep worklist. RULES CALCULATE (tier + cadence are deterministic); AI only drafts copy.

export type Tier = "A" | "B" | "C";
export type Channel = "call" | "email" | "linkedin" | "task" | "monitor";

export const TIER_LABEL: Record<Tier, string> = {
  A: "Tier A — call first",
  B: "Tier B — email sequence",
  C: "Tier C — monitor",
};

export interface TierDecision {
  tier: Tier;
  channel: Channel; // primary channel for the tier
  reasons: string[]; // transparent: why this tier
}

/** A single touch in a cadence template. day = days after enrollment. */
export interface CadenceStep {
  day: number;
  channel: Channel;
  label: string; // what the rep does, e.g. "Call + voicemail"
  note?: string;
}

export interface Cadence {
  key: string;
  tier: Tier;
  name: string;
  description: string;
  steps: CadenceStep[];
}

export type EnrollmentStatus = "active" | "paused" | "replied" | "completed" | "stopped";
export type TaskStatus = "pending" | "done" | "skipped";
export type TaskOutcome = "connected" | "voicemail" | "no_answer" | "sent" | "bounced" | "replied" | "not_interested" | "meeting";

export const OUTCOME_LABEL: Record<TaskOutcome, string> = {
  connected: "Connected", voicemail: "Left voicemail", no_answer: "No answer", sent: "Sent",
  bounced: "Bounced", replied: "Replied", not_interested: "Not interested", meeting: "Meeting booked",
};
