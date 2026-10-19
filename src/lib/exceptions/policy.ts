// WS05 — DETERMINISTIC resolution policy. Every function here is PURE (facts in, decision out, with an
// explicit `now` clock) and unit-tested with no DB and no LLM. This is where the "authorized vs delegate
// vs escalate" boundary lives, and it is the single place that preserves the money/schedule/hiring gates.
//
// The policy NEVER proposes a forbidden action: when a mapping would resolve to a money/pricing/schedule/
// hiring/instawork action it is downgraded to DELEGATE (a human does it), enforced via WS03's
// isForbiddenActionType — so a bug in the mapping table can only ever be SAFER, never execute something it
// shouldn't.

import { isForbiddenActionType, type ApprovalActionType } from "@/lib/aiorg/approvals";
import type { CanonicalException, EscalationTier, ExceptionSeverity, OwnerRole, ResolutionStatus } from "./types";

// ── Retry / escalation thresholds (explicit + env-configurable, mission "Required design") ─────────────

export interface ResolutionConfig {
  /** An OPEN exception older than this (hours) with no landed resolution → escalate (team). */
  escalateAfterHours: number;
  /** A resolution that has FAILED this many times → escalate to owner (repeatedly failing). */
  maxResolveAttempts: number;
  /** Severities that go STRAIGHT to the owner tier (genuinely high-impact). */
  ownerSeverities: ReadonlySet<ExceptionSeverity>;
}

function parseSeverityList(raw: string | undefined, fallback: ExceptionSeverity[]): Set<ExceptionSeverity> {
  const valid: ExceptionSeverity[] = ["low", "medium", "high", "critical"];
  if (!raw) return new Set(fallback);
  const picked = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ExceptionSeverity => (valid as string[]).includes(s));
  return new Set(picked.length ? picked : fallback);
}

export function resolutionConfig(): ResolutionConfig {
  const h = Number(process.env.EXCEPTION_ESCALATE_AFTER_HOURS);
  const n = Number(process.env.EXCEPTION_MAX_RESOLVE_ATTEMPTS);
  return {
    escalateAfterHours: Number.isFinite(h) && h > 0 ? h : 24,
    maxResolveAttempts: Number.isFinite(n) && n > 0 ? Math.floor(n) : 2,
    ownerSeverities: parseSeverityList(process.env.EXCEPTION_OWNER_SEVERITIES, ["critical"]),
  };
}

// ── Severity normalization ──────────────────────────────────────────────────────────────────────────

/** PURE. Normalize a risk-engine severity (CRITICAL|HIGH|MEDIUM|LOW) to the four-level scale. */
export function normalizeRiskSeverity(sev: string): ExceptionSeverity {
  switch (sev.toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "medium";
    default:
      return "low";
  }
}

// ── Owner-role mapping (deterministic; team-level routing) ─────────────────────────────────────────────

/** PURE. Map a canonical exception to the team role that owns it. Used for DELEGATE + team-tier escalation
 *  (so team-owned work routes to the right people before any owner escalation). Env-overridable per source
 *  type via EXCEPTION_ROLE_<TYPE> is intentionally NOT added here — mapping stays in code (auditable). */
export function ownerRoleFor(e: CanonicalException): OwnerRole {
  if (e.source === "dead_letter") return "ops"; // a dead-lettered write-back is an ops/tech concern
  const target = (e.actionTarget ?? "").toLowerCase();
  if (target === "connecteam") return "scheduling"; // staffing / crew / driver availability
  if (target === "dispatch") return "dispatch"; //     route / driver assignment
  // actionTarget "goodshuffle" or unknown — refine by the finer type.
  const t = e.type.toLowerCase();
  if (t.includes("warehouse") || t.includes("inventory") || t.includes("pickup") || t.includes("setup")) return "warehouse";
  if (t.includes("payment")) return "finance";
  if (t.includes("customer") || t.includes("communication")) return "sales";
  return "ops";
}

// ── Resolution routing (the authorized-vs-delegate-vs-escalate decision) ───────────────────────────────

export type ResolutionPlanKind = "propose" | "delegate" | "escalate";

export interface ResolutionPlan {
  kind: ResolutionPlanKind;
  /** For "propose": the NON-forbidden action to put through the shared approval → outbox path. */
  actionType?: ApprovalActionType;
  /** For "delegate" / team escalation: the owning role. */
  role?: OwnerRole;
  /** Human-readable rationale (goes into next_action / the card / the audit). */
  reason: string;
}

/**
 * PURE. Decide how to resolve an exception. The ONLY path that auto-PROPOSES an action (still human-gated
 * downstream) is a Goodshuffle-writable risk with a transactionID, resolved by appending the recommended
 * action to the project as a tracked task (create_gs_task — an ungated, proven outbox op). Everything that
 * touches money/schedule/hiring/crew, or has no safe autonomous action, is DELEGATED to its role. A
 * dead-lettered write-back is ESCALATED (its action already failed; only a human can intervene).
 *
 * Defense-in-depth: if the chosen actionType is forbidden to execute (WS03 isForbiddenActionType), the plan
 * is forced to DELEGATE — the policy can never emit a forbidden proposal.
 */
export function planResolution(e: CanonicalException): ResolutionPlan {
  if (e.source === "dead_letter") {
    return { kind: "escalate", role: "ops", reason: "A Goodshuffle write-back exhausted its bounded retries (dead-letter). It never reached Goodshuffle — a human must re-run or cancel it." };
  }

  // Risk-sourced. Only a Goodshuffle-writable risk carrying a transactionID gets an autonomous proposal.
  const target = (e.actionTarget ?? "").toLowerCase();
  const role = ownerRoleFor(e);

  if (target === "goodshuffle" && e.transactionId) {
    const actionType: ApprovalActionType = "create_gs_task";
    if (isForbiddenActionType(actionType)) {
      // Can't happen for create_gs_task, but the guard makes the invariant explicit + future-proof.
      return { kind: "delegate", role, reason: `Resolution action ${actionType} is forbidden to execute; a human must handle it.` };
    }
    return {
      kind: "propose",
      actionType,
      role,
      reason: "Put the recommended action onto the Goodshuffle project as a tracked task so the office has it in the system of record. Human-approved before it sends; verified after it lands.",
    };
  }

  // connecteam / dispatch / payment / anything else → a human with the authority does it.
  return {
    kind: "delegate",
    role,
    reason: `This fix lives in ${e.actionTarget ?? "an operational tool"} and is not autonomously executable (it can touch staffing, scheduling, routing, or money). Routed to the ${role} team with the recommended action and deadline.`,
  };
}

// ── Escalation tier (team before owner) ────────────────────────────────────────────────────────────────

export interface EscalationInput {
  severity: ExceptionSeverity;
  status: ResolutionStatus;
  /** How many times a proposed resolution has FAILED (dead-lettered / approval-failed). */
  resolveAttempts: number;
  /** When WE first recorded the exception (ISO). */
  firstDetectedAt: string | null;
  /** The source's hard deadline (ISO), if any. */
  deadline: string | null;
  /** The tier already reached (so team→owner only progresses, never regresses). */
  currentTier: EscalationTier;
  now: number;
  cfg?: ResolutionConfig;
}

/**
 * PURE. Decide the escalation tier an exception should be at. Returns the tier it should REACH now:
 *   • owner  — genuinely high-impact (owner-severity), OR repeatedly failing (attempts ≥ budget), OR
 *              already escalated to the team AND now overdue past its deadline. (The owner handles tech +
 *              escalations; a team-owned item only reaches them under THESE criteria — never automatically.)
 *   • team   — a failed resolution, OR an OPEN exception overdue past escalateAfterHours / its deadline.
 *   • none   — nothing yet warrants an escalation.
 * Monotonic: never returns a LOWER tier than currentTier (an escalation doesn't un-escalate here; closing
 * the exception is what clears it).
 */
export function escalationTier(input: EscalationInput): EscalationTier {
  const cfg = input.cfg ?? resolutionConfig();
  const { now } = input;

  const overdueByAge =
    input.firstDetectedAt != null &&
    Number.isFinite(Date.parse(input.firstDetectedAt)) &&
    now - Date.parse(input.firstDetectedAt) > cfg.escalateAfterHours * 3_600_000;
  const overdueByDeadline = input.deadline != null && Number.isFinite(Date.parse(input.deadline)) && Date.parse(input.deadline) < now;
  const overdue = overdueByAge || overdueByDeadline;

  const ownerBySeverity = cfg.ownerSeverities.has(input.severity);
  const ownerByRepeatFailure = input.resolveAttempts >= cfg.maxResolveAttempts;
  const ownerByOverdueAfterTeam = input.currentTier === "team" && overdue;

  let tier: EscalationTier = "none";
  if (ownerBySeverity || ownerByRepeatFailure || ownerByOverdueAfterTeam) tier = "owner";
  else if (input.status === "failed" || overdue) tier = "team";

  // Monotonic: never regress below the tier already reached.
  const rank: Record<EscalationTier, number> = { none: 0, team: 1, owner: 2 };
  return rank[tier] >= rank[input.currentTier] ? tier : input.currentTier;
}
