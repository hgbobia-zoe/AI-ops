// Cross-agent EXCEPTION RESOLUTION lifecycle (WS05) — domain types.
//
// This is a THIN coordination layer over the EXISTING exception/alert surfaces (Event Risk Engine
// risk_items, scheduling shift_exceptions, the WS03 outbox dead-letter backlog, …). It does NOT invent a
// parallel exception queue or a second orchestration bus: each detector reads its own source and emits a
// CanonicalException; the engine dedupes by a stable key, routes a DETERMINISTIC resolution (propose an
// authorized action via the shared ai_approvals → gs_outbox path, delegate to a human role, or escalate),
// VERIFIES the result through WS03's getApprovalLifecycle, and escalates when it can't resolve.
//
// Governing law: RULES CALCULATE, AI INTERPRETS. Every routing/severity/escalation decision here is a pure
// function of the facts (unit-tested, no DB, no LLM). An LLM may only draft human-readable prose later.
//
// Honesty laws carried from the mission brief:
//   • A notification is not a resolution.           • An approval is not execution.
//   • An HTTP/destination success is not real-world completion for an OUTREACH action.
//   • Disappearance from a scan is NOT proof of resolution.
//   • Missing/stale data is NOT a healthy state.
//   • A team-owned exception does NOT auto-escalate to the business owner.

/** The existing surface a canonical exception was normalized from. Extensible — add an adapter, not a bus. */
export type ExceptionSource = "risk" | "dead_letter";

/** Normalized severity (source severities are mapped onto this four-level scale deterministically). */
export type ExceptionSeverity = "low" | "medium" | "high" | "critical";

/**
 * The coordination lifecycle state of an exception — OUR state, kept separate from the source's own
 * reconcile lifecycle (we never flip the source row). These are exactly the states the UI/Slack summary
 * must distinguish (mission acceptance #7): active, awaiting-human-action, failed, verified-resolved,
 * unverifiable — plus the in-between acting/delegated/escalated/disposed.
 */
export type ResolutionStatus =
  | "active" //            detected + classified, no coordination action taken yet
  | "delegated" //         routed to a team role/person; awaiting THEIR human action (not autonomously executable)
  | "awaiting_approval" // an authorized resolution was PROPOSED as an approval card; awaiting a human decision
  | "acting" //            approved + enqueued to the outbox; awaiting the drainer (WS03 verifies)
  | "resolved" //          the authorized action is VERIFIED landed (confirmed) — carries verification evidence
  | "failed" //            the resolution action dead-lettered / the approval failed (needs a human) — triggers escalation
  | "escalated" //         escalated to team or owner (tier recorded); still OPEN
  | "unverifiable" //      the source signal went missing/stale, or the approval vanished — NOT healthy, surfaced for a human
  | "disposed"; //         a human recorded a justified final disposition (rejected / closed-by-hand)

/** How far an escalation has reached. Team-level ALWAYS precedes owner-level (mission required distinction). */
export type EscalationTier = "none" | "team" | "owner";

/** Which human role owns a delegated/escalated exception. Deterministic, mapped from the source. */
export type OwnerRole = "scheduling" | "dispatch" | "warehouse" | "sales" | "finance" | "ops";

/**
 * The normalized exception a detector emits, independent of its source surface. The engine persists and
 * reasons over THIS, never the raw source row.
 */
export interface CanonicalException {
  source: ExceptionSource;
  /** Stable per-source identity (risk signature / outbox op id). (source, sourceId) is globally unique. */
  sourceId: string;
  /** Finer machine type, e.g. the riskType ("route_no_driver") or "dead_letter_op". */
  type: string;
  severity: ExceptionSeverity;
  title: string;
  detail: string;
  /** Where the fix lives, carried from the source ("goodshuffle" | "connecteam" | "dispatch" | null). */
  actionTarget?: string | null;
  /** Goodshuffle transactionID, when the resolution can be written onto the project. */
  transactionId?: string | null;
  /** A hard deadline for the recommendation (ISO), when the source supplies one. */
  deadline?: string | null;
  /** The source's human-readable recommended action (becomes the task/note body + the card). */
  recommendedAction?: string | null;
  /** The source's own owner hint (e.g. "Warehouse / Ops"), if any. */
  ownerHint?: string | null;
  /** When the source first observed this (ISO) — drives overdue/stale escalation. */
  firstDetectedAt?: string | null;
  /** Arbitrary evidence for the card + audit (never used for a decision). */
  evidence?: Record<string, unknown>;
}

/** The stable coordination key: `${source}:${sourceId}`. Dedup + idempotency hinge on this. PURE. */
export function exceptionKey(e: Pick<CanonicalException, "source" | "sourceId">): string {
  return `${e.source}:${e.sourceId}`;
}

/** A persisted exception-resolution record (mirrors the exception_resolutions table). */
export interface ExceptionResolution {
  key: string;
  source: ExceptionSource;
  sourceId: string;
  type: string;
  severity: ExceptionSeverity;
  status: ResolutionStatus;
  title: string;
  detail: string | null;
  assignedRole: OwnerRole | null;
  nextAction: string | null;
  deadline: string | null;
  approvalId: string | null;
  resolveAttempts: number;
  lastAttemptAt: string | null;
  escalationTier: EscalationTier;
  escalatedAt: string | null;
  /** JSON evidence that the resolution actually landed (phase, outboxOpId, confirmedAt, attempts). */
  verificationEvidence: Record<string, unknown> | null;
  disposition: string | null;
  disposedBy: string | null;
  firstDetectedAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

/** Statuses considered OPEN (still need coordination). Resolved + disposed are terminal. */
export const OPEN_STATUSES: ReadonlySet<ResolutionStatus> = new Set<ResolutionStatus>([
  "active",
  "delegated",
  "awaiting_approval",
  "acting",
  "failed",
  "escalated",
  "unverifiable",
]);

/** Terminal statuses (closed) — a closed exception is never re-opened or re-proposed by a later scan. */
export const TERMINAL_STATUSES: ReadonlySet<ResolutionStatus> = new Set<ResolutionStatus>(["resolved", "disposed"]);
