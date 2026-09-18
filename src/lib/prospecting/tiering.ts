// Prospecting — deterministic tiering (§12 reuse). Routes an opportunity to a motion by the score
// already computed, plus the signals that justify a phone-first touch. Transparent: every tier lists
// its reasons. Config-driven thresholds. NEVER an AI call.

import type { OpportunityView } from "@/lib/opportunity/service";
import type { Tier, TierDecision } from "./types";

export interface TieringConfig {
  callFirstScore: number; // at/above this opportunity score → Tier A (call-first)
  emailScore: number; // at/above this → Tier B (email sequence); below → Tier C (monitor)
}

export const DEFAULT_TIERING: TieringConfig = {
  callFirstScore: 70,
  emailScore: 40,
};

/**
 * Tier a prospect. Phone-first (Tier A) for the ones worth a human touch: a high score, an already-
 * awarded opportunity (a real contractor to build a relationship with), or an existing Zoe
 * relationship (warm — always call). Everything else that clears the email bar is a sequence (Tier B);
 * the rest is monitor-only (Tier C).
 */
export function tierFor(v: OpportunityView, opts: { awarded?: boolean } = {}, config: TieringConfig = DEFAULT_TIERING): TierDecision {
  const reasons: string[] = [];
  const score = v.score.opportunityScore;

  const highScore = score >= config.callFirstScore;
  const warm = v.hasExistingRelationship;
  const awarded = !!opts.awarded;

  if (v.score.tier === "UNQUALIFIED" || score < config.emailScore) {
    return { tier: "C", channel: "monitor", reasons: ["Below the outreach bar — monitor for change"] };
  }

  let tier: Tier;
  if (warm) { tier = "A"; reasons.push("Existing Zoe relationship — call to re-engage"); }
  else if (awarded) { tier = "A"; reasons.push("Already awarded — call the contractor to build the relationship"); }
  else if (highScore) { tier = "A"; reasons.push(`High opportunity score (${score}) — worth a personal call`); }
  else { tier = "B"; reasons.push(`Qualified (${score}) — run an email sequence`); }

  if (tier === "A" && !v.primaryTarget) reasons.push("No contact yet — enrich before calling");
  return { tier, channel: tier === "A" ? "call" : "email", reasons };
}
