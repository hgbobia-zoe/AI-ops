// Shift + assignment LIFECYCLE — the deterministic state machine, modeled 1:1 on src/lib/stateMachine.ts
// (a declarative transition table for the per-worker assignment, and a pure roll-up for the shift state).
//
// Design law: RULES CALCULATE. The shift state is ALWAYS a deterministic roll-up of its assignments'
// states + the coverage/readiness facts — never set by an LLM, never hand-edited past the guards. An
// unknown stays unknown; we never fabricate a transition the facts don't support.
//
// Migration (I of the design): lifecycle_state is authoritative going forward, but is derived from the
// legacy ShiftStatus when null and projected back to it, so neither the old board nor the engine breaks.

import type { AssignmentState, ShiftLifecycleState, ShiftStatus } from "./types";

// ── Legacy status <-> lifecycle mapping (dual-write / derive, for the additive migration) ──────────

/** Backfill a lifecycle state from the legacy flat status (I.3). Used only when lifecycle_state is null. */
export function deriveLifecycleFromStatus(status: ShiftStatus): ShiftLifecycleState {
  switch (status) {
    case "sent":
      return "PROVISIONED"; // pushed to Connecteam and/or posted to Instawork
    case "confirmed":
      return "STAFFED"; // human OK'd it, ready to send
    case "cancelled":
      return "CANCELLED";
    case "draft":
    default:
      return "DRAFT";
  }
}

/** Project a lifecycle state back onto the legacy status so the existing board/coverage stay in sync.
 *  Everything from PROVISIONED onward reads as "sent" (it has left the building); STAFFED/READY-but-not-
 *  sent reads as "confirmed"; DRAFT/EXCEPTION as "draft"; CANCELLED as "cancelled". */
export function legacyStatusFor(state: ShiftLifecycleState): ShiftStatus {
  switch (state) {
    case "CANCELLED":
      return "cancelled";
    case "DRAFT":
    case "EXCEPTION":
      return "draft";
    case "STAFFED":
      return "confirmed";
    case "PROVISIONED":
    case "NOTIFIED":
    case "CONFIRMED":
    case "READY":
    case "IN_PROGRESS":
    case "COMPLETE":
      return "sent";
    default:
      return "draft";
  }
}

// ── ASSIGNMENT (per-worker) state machine — declarative, mirrors stateMachine.ts ───────────────────

export interface AssignmentTransition {
  from: AssignmentState;
  action: string; // ASSIGN | NOTIFY | CONFIRM | CLOCK_IN | CLOCK_OUT | DECLINE | NO_SHOW | CANCEL | REPLACE
  to: AssignmentState;
  label: string;
  /** Guarded: only a dispatcher/admin may fire it (e.g. cancel a confirmed worker). */
  requiresApproval?: boolean;
}

export const ASSIGNMENT_TRANSITIONS: AssignmentTransition[] = [
  { from: "PROPOSED", action: "ASSIGN", to: "ASSIGNED", label: "Assign" },
  { from: "PROPOSED", action: "DECLINE", to: "DECLINED", label: "Declined" },
  { from: "ASSIGNED", action: "NOTIFY", to: "NOTIFIED", label: "Send packet" },
  { from: "ASSIGNED", action: "DECLINE", to: "DECLINED", label: "Declined" },
  { from: "ASSIGNED", action: "CANCEL", to: "CANCELLED", label: "Cancel", requiresApproval: true },
  { from: "NOTIFIED", action: "CONFIRM", to: "CONFIRMED", label: "Confirm" },
  { from: "NOTIFIED", action: "DECLINE", to: "DECLINED", label: "Declined" },
  { from: "NOTIFIED", action: "NO_SHOW", to: "NO_SHOW", label: "No-show" },
  { from: "NOTIFIED", action: "CANCEL", to: "CANCELLED", label: "Cancel", requiresApproval: true },
  { from: "CONFIRMED", action: "CLOCK_IN", to: "CLOCKED_IN", label: "Clocked in" },
  { from: "CONFIRMED", action: "NO_SHOW", to: "NO_SHOW", label: "No-show" },
  { from: "CONFIRMED", action: "CANCEL", to: "CANCELLED", label: "Cancel", requiresApproval: true },
  { from: "CLOCKED_IN", action: "CLOCK_OUT", to: "CLOCKED_OUT", label: "Clocked out" },
  // A still-active assignment can be swapped out for a replacement at any pre-clock-out point.
  { from: "ASSIGNED", action: "REPLACE", to: "REPLACED", label: "Replaced", requiresApproval: true },
  { from: "NOTIFIED", action: "REPLACE", to: "REPLACED", label: "Replaced", requiresApproval: true },
  { from: "CONFIRMED", action: "REPLACE", to: "REPLACED", label: "Replaced", requiresApproval: true },
];

export interface AssignmentActionContext {
  isAdmin?: boolean;
}

/** Authoritative validity check (server-side guard): the resulting state for a legal transition, or null.
 *  Mirrors stateMachine.resolveTransition exactly. */
export function resolveAssignmentTransition(
  from: AssignmentState,
  action: string,
  ctx: AssignmentActionContext = {},
): AssignmentState | null {
  const match = ASSIGNMENT_TRANSITIONS.find((t) => t.from === from && t.action === action);
  if (!match) return null;
  if (match.requiresApproval && !ctx.isAdmin) return null;
  return match.to;
}

/** The actions available from an assignment state (guarded ones only when admin). */
export function getAssignmentActions(
  state: AssignmentState,
  ctx: AssignmentActionContext = {},
): { action: string; to: AssignmentState; label: string }[] {
  return ASSIGNMENT_TRANSITIONS.filter((t) => t.from === state)
    .filter((t) => (t.requiresApproval ? Boolean(ctx.isAdmin) : true))
    .map((t) => ({ action: t.action, to: t.to, label: t.label }));
}

const TERMINAL_ASSIGNMENT: ReadonlySet<AssignmentState> = new Set<AssignmentState>([
  "CLOCKED_OUT",
  "DECLINED",
  "CANCELLED",
  "REPLACED",
]);

/** Does this assignment count as a live, committed seat for coverage/roll-up purposes? */
export function isLiveAssignment(state: AssignmentState): boolean {
  return !TERMINAL_ASSIGNMENT.has(state) && state !== "NO_SHOW" && state !== "PROPOSED";
}

// ── SHIFT lifecycle — the deterministic roll-up (D.4) ──────────────────────────────────────────────

/** The facts the shift lifecycle rolls up from. All deterministic, all computable from the DB + clocks. */
export interface ShiftLifecycleFacts {
  cancelled: boolean;
  /** Coverage gap (headcount minus covered). 0 = fully staffed. */
  gap: number;
  windowKnown: boolean;
  /** Published to Connecteam (connecteam_shift_id set). */
  published: boolean;
  /** An Instawork gig posted/recorded for the temp seats. */
  gigPosted: boolean;
  /** Live assignments on the shift (terminal/no-show/proposed excluded by the caller). */
  assignmentCount: number;
  /** Every live assignment has a packet_sent_at. */
  allPacketsSent: boolean;
  /** Every live assignment has a confirmed_at. */
  allConfirmed: boolean;
  /** computeShiftReadiness(...) === "READY" (all five components green). */
  readinessReady: boolean;
  /** Any live assignment has a mirrored clock-in. */
  anyClockIn: boolean;
  /** A RED/blocking exception is open against the shift. */
  blockingException: boolean;
  now: number; // epoch ms
  startMs: number | null; // shift start epoch ms (null = unknown)
  endMs: number | null; // shift end epoch ms (null = unknown)
}

/**
 * Derive the shift's lifecycle state from the facts, deterministically (D.4). This is recomputed each
 * tick and on each action, so a regression (gap reopens, a worker drops) self-heals to the correct lower
 * state. CANCELLED and time-based terminal/active states take precedence over the readiness progression;
 * a blocking RED exception overlays EXCEPTION on any non-terminal active state.
 */
export function deriveShiftLifecycle(f: ShiftLifecycleFacts): ShiftLifecycleState {
  if (f.cancelled) return "CANCELLED";

  const started = f.startMs != null && f.now >= f.startMs;
  const ended = f.endMs != null && f.now >= f.endMs;

  // Time wins over the readiness progression once the shift's clock has moved.
  if (ended) {
    return f.blockingException ? "EXCEPTION" : "COMPLETE";
  }
  if (started || f.anyClockIn) {
    return f.blockingException ? "EXCEPTION" : "IN_PROGRESS";
  }

  // Pre-start readiness progression — each level requires every lower condition.
  let base: ShiftLifecycleState;
  if (f.gap > 0 || !f.windowKnown) {
    base = "DRAFT";
  } else if (!(f.published || f.gigPosted) || f.assignmentCount === 0) {
    base = "STAFFED";
  } else if (!f.allPacketsSent) {
    base = "PROVISIONED";
  } else if (!f.allConfirmed) {
    base = "NOTIFIED";
  } else if (!f.readinessReady) {
    base = "CONFIRMED";
  } else {
    base = "READY";
  }

  // A RED exception open against an active shift surfaces as EXCEPTION (returns to prior on resolve).
  if (f.blockingException) return "EXCEPTION";
  return base;
}

/** Is a shift lifecycle state terminal (no further automated progression)? */
export function isTerminalShiftState(state: ShiftLifecycleState): boolean {
  return state === "COMPLETE" || state === "CANCELLED";
}
