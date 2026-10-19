// Did-It-Land verification lifecycle (WS03) — the REUSABLE execution-verification contract shared by
// every Goodshuffle write-back op, regardless of type. It stacks on WS02's defect fixes (the outbox
// drainers now ack email_send / create_gs_task; the ack endpoint is the single shared choke point).
//
// The problem it closes: an approval was stamped `executed` the instant its op was ENQUEUED (that means
// QUEUED, not delivered), and a drainer ack (done/failed) never reconciled back to the approval, so a
// delivered op sat at "executed" forever and a failed op died silently with no retry. This module makes
// the two state machines ONE honest lifecycle and gives every op uniform bounded retry + dead-letter.
//
//   requested/approved → QUEUED (op enqueued) → [drainer ack] → CONFIRMED (destination accepted)
//                                             → FAILED (transient) → retry w/ backoff → DEAD (exhausted)
//
// Honesty law: CONFIRMED means the destination (Goodshuffle) ACCEPTED the write per the drainer ack —
// NOT that a human recipient received or read it. Where a stronger downstream signal exists (an email's
// deliveryConfirmedDate / hardBounced on the next pull) a caller may reconcile further; where it does
// not, we never fabricate "delivered". See reconcileApprovalForOp.
//
// Deterministic by design (RULES CALCULATE): the transition + backoff are pure functions, unit-tested
// with an explicit clock and no DB. The two DB wrappers are thin glue. This module imports ONLY the db
// handle (never repo.ts) so repo.ackGsOp can call it without an import cycle.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

// ── Retry / dead-letter policy (deterministic, configurable via env with safe defaults) ───────────────

/** Default retry budget when a row carries no explicit max_attempts. Each drainer pass that acks a
 *  failure counts as one attempt; once attempts reach the budget the op is dead-lettered. */
export const DEFAULT_MAX_ATTEMPTS = 6;

/** Backoff base + cap. Drain cadence is ~10 min when the office tab is open, so the first retry waits a
 *  little over one cadence and grows geometrically, capped so a long-lived op still retries a few times
 *  a day rather than stalling for a week. */
export const BACKOFF_BASE_MS = 10 * 60 * 1000; //   10 minutes
export const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface RetryConfig {
  defaultMaxAttempts: number;
  baseMs: number;
  capMs: number;
}

export function retryConfig(): RetryConfig {
  const n = Number(process.env.OUTBOX_MAX_ATTEMPTS);
  return {
    defaultMaxAttempts: Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_ATTEMPTS,
    baseMs: BACKOFF_BASE_MS,
    capMs: BACKOFF_CAP_MS,
  };
}

/** PURE. Exponential backoff for the Nth attempt (1-based): base * 2^(attempt-1), capped. */
export function backoffMs(attempt: number, cfg: RetryConfig = retryConfig()): number {
  const a = Math.max(1, Math.floor(attempt));
  const raw = cfg.baseMs * Math.pow(2, a - 1);
  return Math.min(raw, cfg.capMs);
}

/** The op-level terminal/holding status after an ack. 'pending' = kept eligible for a bounded retry
 *  (held behind next_attempt_at); 'done' = destination accepted; 'dead' = retries exhausted (dead-letter,
 *  needs a human). 'failed' is NOT produced here any more — it survives only as a legacy value on old rows. */
export type OutboxAckStatus = "done" | "pending" | "dead";

export interface AckInputRow {
  attempts: number; //            attempts SO FAR (before this ack)
  maxAttempts: number | null; //  per-op budget, null => cfg default
}

export interface AckTransition {
  status: OutboxAckStatus;
  attempts: number; //          attempts AFTER this ack (row.attempts + 1)
  nextAttemptAt: string | null; // ISO backoff gate for a retry, else null
  deadLetteredAt: string | null; // ISO when exhausted, else null
  lastError: string | null; //   error to record (null on success)
  retrying: boolean; //          true when a transient failure will be retried
}

/** PURE. Decide the next op-level state from an ack. On success → done. On failure → retry (pending +
 *  backoff) until the attempt budget is hit, then dead-letter. Never retries past the budget, and never
 *  silently drops a failure (a dead op is visible + actionable). */
export function decideAckTransition(
  row: AckInputRow,
  ok: boolean,
  error: string | undefined,
  now: number,
  cfg: RetryConfig = retryConfig(),
): AckTransition {
  const attempts = row.attempts + 1;
  if (ok) {
    return { status: "done", attempts, nextAttemptAt: null, deadLetteredAt: null, lastError: null, retrying: false };
  }
  const max = row.maxAttempts && row.maxAttempts > 0 ? row.maxAttempts : cfg.defaultMaxAttempts;
  const err = error ?? "unknown";
  if (attempts >= max) {
    return { status: "dead", attempts, nextAttemptAt: null, deadLetteredAt: new Date(now).toISOString(), lastError: err, retrying: false };
  }
  const at = new Date(now + backoffMs(attempts, cfg)).toISOString();
  return { status: "pending", attempts, nextAttemptAt: at, deadLetteredAt: null, lastError: err, retrying: true };
}

// ── Approval reconciliation (the consumer side — links the outbox op back to its ai_approvals row) ────

/** The subset of an approval row this module touches. */
interface ApprovalLite {
  id: string;
  status: string;
  agent_id: string;
  action_type: string;
}

// An approval is "in flight" (awaiting its op's outcome) when it is queued, or a legacy 'executed' row
// (pre-WS03 those were stamped executed on enqueue). Both reconcile forward on an ack. Terminal states
// (confirmed / failed / rejected / approved-held) are left alone so reconciliation is idempotent.
const IN_FLIGHT = new Set(["queued", "executed"]);

/** Minimal, cycle-free audit insert (mirrors repo.insertAudit's row shape). This module must not import
 *  repo.ts — repo.ackGsOp imports THIS module — so it writes the audit row directly. */
function audit(actor: string, action: string, approvalId: string, detail: Record<string, unknown>): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO audit_logs (audit_id, actor, action, entity, entity_id, before, after, ts)
         VALUES (@id, @actor, @action, 'ai_approval', @entityId, NULL, @after, @now)`,
      )
      .run({ id: `A-${randomUUID()}`, actor, action, entityId: approvalId, after: JSON.stringify(detail), now: new Date().toISOString() });
  } catch {
    /* audit is best-effort — it must never fail the ack/reconcile */
  }
}

export interface ReconcileResult {
  reconciled: boolean; //  an in-flight approval was moved
  approvalId?: string;
  from?: string;
  to?: string;
}

/**
 * Reconcile the ai_approvals row linked to an outbox op (by outbox_op_id) after the op reaches a new
 * state. Called from repo.ackGsOp for EVERY op type, so every approval-backed action gets the same
 * honest lifecycle:
 *   • op done  → approval CONFIRMED   (destination accepted the write — NOT a recipient read receipt)
 *   • op dead  → approval FAILED      (bounded retries exhausted; carries the dead-letter reason, needs a human)
 *   • op pending (a transient failure that will retry) → approval stays QUEUED, note updated with the attempt
 *
 * Idempotent: an op with no linked approval (e.g. a direct Sales send-email or a coach note) is a no-op,
 * and an approval already in a terminal state is never moved. Deterministic; no LLM.
 */
export function reconcileApprovalForOp(opId: string, op: AckTransition, actor = "outbox-drainer"): ReconcileResult {
  if (!opId) return { reconciled: false };
  const db = getDb();
  const row = db.prepare("SELECT id, status, agent_id, action_type FROM ai_approvals WHERE outbox_op_id = ?").get(opId) as ApprovalLite | undefined;
  if (!row) return { reconciled: false };
  if (!IN_FLIGHT.has(row.status)) return { reconciled: false, approvalId: row.id, from: row.status, to: row.status };

  const now = new Date().toISOString();
  if (op.status === "done") {
    const note = "Confirmed: Goodshuffle accepted the write (destination acceptance — not a recipient delivery/read receipt).";
    db.prepare("UPDATE ai_approvals SET status='confirmed', decision_note=@note WHERE id=@id").run({ id: row.id, note });
    audit(actor, "APPROVAL_CONFIRMED", row.id, { agent: row.agent_id, actionType: row.action_type, outboxOpId: opId, at: now, attempts: op.attempts });
    return { reconciled: true, approvalId: row.id, from: row.status, to: "confirmed" };
  }
  if (op.status === "dead") {
    const note = `Dead-lettered after ${op.attempts} attempt${op.attempts === 1 ? "" : "s"}: ${op.lastError ?? "unknown"}. Needs a human — the action never reached Goodshuffle.`;
    db.prepare("UPDATE ai_approvals SET status='failed', decision_note=@note WHERE id=@id").run({ id: row.id, note });
    audit(actor, "APPROVAL_FAILED", row.id, { agent: row.agent_id, actionType: row.action_type, outboxOpId: opId, reason: "dead_letter", attempts: op.attempts, error: op.lastError });
    return { reconciled: true, approvalId: row.id, from: row.status, to: "failed" };
  }
  // status 'pending' — a transient failure that will retry. Keep the approval QUEUED; record the attempt
  // so the human sees it isn't stuck silently. Promote a legacy 'executed' row to 'queued' for honesty.
  const note = `Attempt ${op.attempts} did not land (${op.lastError ?? "unknown"}); queued to retry${op.nextAttemptAt ? ` after ${op.nextAttemptAt}` : ""}.`;
  db.prepare("UPDATE ai_approvals SET status='queued', decision_note=@note WHERE id=@id").run({ id: row.id, note });
  audit(actor, "APPROVAL_RETRY", row.id, { agent: row.agent_id, actionType: row.action_type, outboxOpId: opId, attempt: op.attempts, nextAttemptAt: op.nextAttemptAt, error: op.lastError });
  return { reconciled: true, approvalId: row.id, from: row.status, to: "queued" };
}
