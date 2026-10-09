// Independent event READINESS axis — PURE (no DB/net/AI).
//
// This is a SEPARATE dimension from the lifecycle state (an event can be BOOKED + AT_RISK). It rolls up
// the event's data-backed REQUIREMENTS (requirements.ts) together with the EXISTING Event Risk Engine's
// findings for this event. It does NOT invent any new risk signal — the risk severity/score come wholly
// from src/lib/risk (engine.ts findings → readiness.ts computeReadiness), so there is ONE risk system.
//
// Reused (no second risk system):
//   • computeReadiness (src/lib/risk/readiness.ts) — the existing per-event 0-100 score + worst severity,
//     which itself keys risk/engine.ts findings to the event (findingAffects) and ignores unverified
//     findings. We consume its output; we never recompute severity.

import { computeReadiness, type ReadinessInput } from "@/lib/risk/readiness";
import type { RiskFinding, RiskSeverity } from "@/lib/risk/types";
import type { EventCondition, EventReadinessResult, Requirement } from "./types";

/** How near (days) a CRITICAL risk must be to count as ESCALATED (vs merely AT_RISK). */
const ESCALATION_PROXIMITY_DAYS = 7;

export interface EventReadinessOpts {
  /** The event context the EXISTING risk readiness needs to key findings to this event. */
  event: ReadinessInput;
  /** Days until the event (drives ESCALATED). null = undated. */
  daysUntilEvent?: number | null;
}

/**
 * Compute the event's readiness condition. PURE.
 *
 * `riskFindings` are the Event Risk Engine's findings (the same RiskFinding[] the risk engine produces);
 * they are keyed to this event by the EXISTING computeReadiness (via `opts.event`), so we pass them
 * straight through rather than re-implementing any matching.
 *
 * Condition precedence (worst first): ESCALATED > BLOCKED > AT_RISK > WATCH > NORMAL.
 *   - ESCALATED: a CRITICAL risk finding AND the event is within the proximity window (imminent + critical).
 *   - BLOCKED:   a BLOCKING requirement is BLOCKED (a hard, data-backed gate is unmet).
 *   - AT_RISK:   a CRITICAL (not imminent) or HIGH risk finding, or a blocking requirement WARNING.
 *   - WATCH:     a MEDIUM/LOW risk finding, or any non-blocking WARNING requirement.
 *   - NORMAL:    none of the above.
 */
export function computeEventReadiness(
  requirements: Requirement[],
  riskFindings: RiskFinding[],
  opts: EventReadinessOpts,
): EventReadinessResult {
  // Reuse the existing per-event risk readiness for the score + worst severity (keyed to the event).
  const [er] = computeReadiness([opts.event], riskFindings);
  const riskLevel = er?.riskLevel ?? "READY";
  const score = er?.score;

  const blockingNotOk = requirements.filter((r) => r.blocking && r.status !== "OK" && r.status !== "UNVERIFIED");
  const hasBlockingBlocked = blockingNotOk.some((r) => r.status === "BLOCKED");
  const hasBlockingWarning = blockingNotOk.some((r) => r.status === "WARNING");
  const hasAnyWarning = requirements.some((r) => r.status === "WARNING");

  const days = opts.daysUntilEvent;
  const imminent = days != null && days >= 0 && days <= ESCALATION_PROXIMITY_DAYS;
  const isCritical = riskLevel === "CRITICAL";
  const isHigh = riskLevel === "HIGH";
  const isMinor = riskLevel === "MEDIUM" || riskLevel === "LOW";

  const reasons: string[] = [];
  let condition: EventCondition;

  if (isCritical && imminent) {
    condition = "ESCALATED";
    reasons.push(`RISK: a CRITICAL risk finding with the event ${days} day(s) out -> ESCALATED.`);
  } else if (hasBlockingBlocked) {
    condition = "BLOCKED";
    reasons.push(`REQUIREMENT: a blocking requirement is BLOCKED (${blockingNotOk.filter((r) => r.status === "BLOCKED").map((r) => r.label).join(", ")}) -> BLOCKED.`);
  } else if (isCritical || isHigh || hasBlockingWarning) {
    condition = "AT_RISK";
    if (isCritical) reasons.push("RISK: a CRITICAL risk finding (not yet imminent) -> AT_RISK.");
    if (isHigh) reasons.push("RISK: a HIGH risk finding -> AT_RISK.");
    if (hasBlockingWarning) reasons.push(`REQUIREMENT: a blocking requirement needs attention (${blockingNotOk.filter((r) => r.status === "WARNING").map((r) => r.label).join(", ")}) -> AT_RISK.`);
  } else if (isMinor || hasAnyWarning) {
    condition = "WATCH";
    if (isMinor) reasons.push(`RISK: a ${riskLevel} risk finding -> WATCH.`);
    if (hasAnyWarning) reasons.push("REQUIREMENT: a non-blocking requirement warning -> WATCH.");
  } else {
    condition = "NORMAL";
    reasons.push("FACT: no blocking deficiencies and no open risk findings -> NORMAL.");
  }

  // Blockers = blocking requirements not satisfied (BLOCKED or a blocking WARNING). UNVERIFIED is an
  // unknown, not a blocker.
  const blockers = blockingNotOk.map((r) => r.label);

  return {
    condition,
    score,
    riskLevel: riskLevel as RiskSeverity | "READY",
    blockers,
    reasons,
  };
}
