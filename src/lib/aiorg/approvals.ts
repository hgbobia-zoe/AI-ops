// AI Org v2 — Approvals over the outbox. An AI employee PROPOSES an action (from a real, already-
// computed draft/signal); this module stores it as an approval request carrying the six-field card,
// and routes an APPROVE to the EXISTING execution path only (a gs_outbox op), respecting the send
// gates. It is NOT a new execution engine: email/note/task enqueue the proven outbox ops; money,
// pricing, schedule, hiring and Instawork-gig actions are FORBIDDEN to execute in v2 (intent recorded,
// never fabricated). SMS has no async outbox op (it delivers live from the Sales lead panel), so an
// approved SMS is held honestly. The pure helpers at the top are unit-tested with no DB.
//
// Governing law holds: RULES CALCULATE, AI INTERPRETS. The six card fields are filled DETERMINISTICALLY
// from the real facts; only the human-readable draft body (where a draft generator already exists) is
// LLM-phrased upstream. No new LLM calls for decisions.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { enqueueGsOp, insertAudit } from "@/lib/db/repo";

// ── Types ─────────────────────────────────────────────────────────────────────
/** Every action an approval can carry. Only the first four are EXECUTABLE in v2 (via the proven
 *  outbox ops / comms path). The rest are proposable/visible but FORBIDDEN to execute here. */
export type ApprovalActionType =
  | "send_email" //     -> gs_outbox email_send (gate EMAIL_SEND_ENABLED)
  | "send_sms" //       -> held: no async outbox op; delivers from the Sales lead panel (gate SMS_SEND_ENABLED)
  | "append_note" //    -> gs_outbox note_append (no master gate)
  | "create_gs_task" // -> gs_outbox create_gs_task (no master gate)
  | "modify_quote" //      FORBIDDEN in v2 (money)
  | "change_pricing" //    FORBIDDEN in v2 (money)
  | "schedule_change" //   FORBIDDEN in v2 (operationally significant)
  | "hiring" //            FORBIDDEN in v2
  | "firing" //            FORBIDDEN in v2
  | "instawork_gig"; //    FORBIDDEN in v2 (no captured write path)

export type ApprovalStatus =
  | "pending"
  | "approved" //       decided yes, but execution held (gate off / forbidden / sms) — intent recorded, never forced
  | "rejected"
  | "edited" //         payload edited by a human; still actionable
  | "info_requested" // sent back to the employee with a note; still actionable
  | "executed" //       the outbox op was enqueued (queued to send; NOT confirmed delivered)
  | "failed";

export type ApprovalDecision = "approve" | "reject" | "edit" | "request_info";

/** The six-field approval card (section 4.4 / 7 of the design doc). Filled deterministically. */
export interface ApprovalCard {
  what: string;
  why: string;
  dataUsed: string;
  expectedOutcome: string;
  risk: string;
  whatIfApproved: string;
}

export interface NewApproval {
  agentId: string;
  owner: string;
  title: string;
  actionType: ApprovalActionType;
  /** The concrete, editable action (e.g. { transactionId, content, subject } for an email). */
  actionPayload: Record<string, unknown>;
  card: ApprovalCard;
  financial?: boolean;
  /** Proposing the same action twice is a no-op when this key already exists. */
  idempotencyKey: string;
}

export interface AiApproval {
  id: string;
  agentId: string;
  owner: string;
  title: string;
  actionType: ApprovalActionType;
  actionPayload: Record<string, unknown>;
  card: ApprovalCard;
  financial: boolean;
  status: ApprovalStatus;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  outboxOpId: string | null;
  idempotencyKey: string | null;
}

// ── Pure helpers (no DB — unit-tested) ─────────────────────────────────────────

/** A status a human can still act on. Terminal states (rejected / executed / failed, and a held
 *  'approved') are NOT decidable — re-deciding is an idempotent no-op. */
const DECIDABLE: ApprovalStatus[] = ["pending", "info_requested", "edited"];

export function canDecide(status: ApprovalStatus): boolean {
  return DECIDABLE.includes(status);
}

/** The next status for a decision, or null when the request is no longer decidable (idempotent no-op).
 *  'approve' yields 'approved' here; the execution step may then move it to 'executed'/'failed'. PURE. */
export function applyDecision(status: ApprovalStatus, decision: ApprovalDecision): ApprovalStatus | null {
  if (!canDecide(status)) return null;
  switch (decision) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "edit":
      return "edited";
    case "request_info":
      return "info_requested";
  }
}

/** The outbox op + env gate an action type maps to on approve. Returns the proven mechanism only —
 *  never invents a path. 'forbidden' = money/pricing/schedule/hiring/instawork (execution not wired
 *  in v2); 'held' = recognised but no async path (SMS). PURE. */
export type ExecutionPlan =
  | { kind: "outbox"; op: "email_send" | "note_append" | "create_gs_task"; gate: "EMAIL_SEND_ENABLED" | null }
  | { kind: "held"; reason: string }
  | { kind: "forbidden"; reason: string };

const FORBIDDEN_REASON: Partial<Record<ApprovalActionType, string>> = {
  modify_quote: "Quote changes touch money — execution is not wired in v2.",
  change_pricing: "Pricing changes touch money — execution is not wired in v2.",
  schedule_change: "Operationally significant schedule changes are not wired to execute in v2.",
  hiring: "Hiring has no backing in the repo — execution is not wired.",
  firing: "Firing has no backing in the repo — execution is not wired.",
  instawork_gig: "No captured Instawork gig-post write path exists — execution is not wired in v2.",
};

export function executionPlan(actionType: ApprovalActionType): ExecutionPlan {
  switch (actionType) {
    case "send_email":
      return { kind: "outbox", op: "email_send", gate: "EMAIL_SEND_ENABLED" };
    case "append_note":
      return { kind: "outbox", op: "note_append", gate: null };
    case "create_gs_task":
      return { kind: "outbox", op: "create_gs_task", gate: null };
    case "send_sms":
      return { kind: "held", reason: "SMS has no async outbox op; it delivers live from the Sales lead panel send. Approving records the decision; delivery stays a human step." };
    default:
      return { kind: "forbidden", reason: FORBIDDEN_REASON[actionType] ?? "Execution is not wired for this action in v2." };
  }
}

/** True when approving this action can only record intent (never executes in v2). PURE. */
export function isForbiddenActionType(actionType: ApprovalActionType): boolean {
  return executionPlan(actionType).kind === "forbidden";
}

/** Turn a plain-text draft into the simple per-line HTML Goodshuffle's editor produces (matches the
 *  email_send route), so the outbox drainer posts well-formed message HTML. PURE. */
export function plainToHtml(text: string): string {
  if (/<\w+[^>]*>/.test(text)) return text;
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n/)
    .map((line) => (line.trim() === "" ? "<div><br></div>" : `<div>${esc(line)}</div>`))
    .join("");
}

/** Build the exact gs_outbox payload the drainer expects for an executable action, from the (possibly
 *  edited) stored payload. PURE — no DB, no env. Returns null for a non-outbox action type. */
export function buildOutboxPayload(
  op: "email_send" | "note_append" | "create_gs_task",
  payload: Record<string, unknown>,
): { transactionId?: string; opPayload: Record<string, unknown> } {
  const txRaw = payload.transactionId;
  const transactionId = typeof txRaw === "string" ? txRaw : typeof txRaw === "number" ? String(txRaw) : undefined;
  const body = typeof payload.body === "string" ? payload.body : "";
  if (op === "email_send") {
    const content = typeof payload.content === "string" && payload.content ? payload.content : plainToHtml(body);
    const subject = typeof payload.subject === "string" ? payload.subject : undefined;
    return { transactionId, opPayload: { content, subject } };
  }
  if (op === "note_append") {
    const line = typeof payload.line === "string" && payload.line ? payload.line : body;
    return { transactionId, opPayload: { line } };
  }
  // create_gs_task
  const title = typeof payload.title === "string" && payload.title ? payload.title : "AI task";
  const note = typeof payload.note === "string" ? payload.note : body;
  return { transactionId, opPayload: { transactionID: transactionId, title, note } };
}

// ── Store (DB) ──────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  agent_id: string;
  owner: string | null;
  title: string;
  action_type: string;
  action_payload: string | null;
  card_what: string | null;
  card_why: string | null;
  card_data_used: string | null;
  card_expected: string | null;
  card_risk: string | null;
  card_what_if: string | null;
  financial: number;
  status: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  outbox_op_id: string | null;
  idempotency_key: string | null;
}

function toApproval(r: Row): AiApproval {
  let payload: Record<string, unknown> = {};
  try {
    payload = r.action_payload ? (JSON.parse(r.action_payload) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  return {
    id: r.id,
    agentId: r.agent_id,
    owner: r.owner ?? "",
    title: r.title,
    actionType: r.action_type as ApprovalActionType,
    actionPayload: payload,
    card: {
      what: r.card_what ?? "",
      why: r.card_why ?? "",
      dataUsed: r.card_data_used ?? "",
      expectedOutcome: r.card_expected ?? "",
      risk: r.card_risk ?? "",
      whatIfApproved: r.card_what_if ?? "",
    },
    financial: r.financial === 1,
    status: r.status as ApprovalStatus,
    createdAt: r.created_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    outboxOpId: r.outbox_op_id,
    idempotencyKey: r.idempotency_key,
  };
}

/** Create an approval request, idempotently. If the idempotency key already exists the existing row is
 *  returned unchanged (proposing the same action twice never duplicates). */
export function createApproval(input: NewApproval): AiApproval {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM ai_approvals WHERE idempotency_key = ?").get(input.idempotencyKey) as Row | undefined;
  if (existing) return toApproval(existing);
  const id = `AP-${randomUUID()}`;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO ai_approvals (id, agent_id, owner, title, action_type, action_payload,
        card_what, card_why, card_data_used, card_expected, card_risk, card_what_if, financial,
        status, created_at, idempotency_key)
       VALUES (@id, @agentId, @owner, @title, @actionType, @actionPayload,
        @what, @why, @dataUsed, @expected, @risk, @whatIf, @financial,
        'pending', @now, @key)`,
    ).run({
      id,
      agentId: input.agentId,
      owner: input.owner,
      title: input.title,
      actionType: input.actionType,
      actionPayload: JSON.stringify(input.actionPayload ?? {}),
      what: input.card.what,
      why: input.card.why,
      dataUsed: input.card.dataUsed,
      expected: input.card.expectedOutcome,
      risk: input.card.risk,
      whatIf: input.card.whatIfApproved,
      financial: input.financial ? 1 : 0,
      now,
      key: input.idempotencyKey,
    });
  } catch {
    // A race on the UNIQUE idempotency key — fall through to the existing row.
    const raced = db.prepare("SELECT * FROM ai_approvals WHERE idempotency_key = ?").get(input.idempotencyKey) as Row | undefined;
    if (raced) return toApproval(raced);
    throw new Error("createApproval failed");
  }
  return toApproval(db.prepare("SELECT * FROM ai_approvals WHERE id = ?").get(id) as Row);
}

export function getApproval(id: string): AiApproval | null {
  const r = getDb().prepare("SELECT * FROM ai_approvals WHERE id = ?").get(id) as Row | undefined;
  return r ? toApproval(r) : null;
}

/** Does an approval with this idempotency key already exist? (So a proposer can count new vs duplicate.) */
export function approvalExistsByKey(key: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM ai_approvals WHERE idempotency_key = ?").get(key);
}

/** Pending + still-actionable requests (the live queue), newest first. */
export function listPendingApprovals(limit = 100): AiApproval[] {
  return (
    getDb()
      .prepare(`SELECT * FROM ai_approvals WHERE status IN ('pending','info_requested','edited') ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Row[]
  ).map(toApproval);
}

/** Decided history (approved / rejected / executed / failed), newest first. */
export function listDecidedApprovals(limit = 100): AiApproval[] {
  return (
    getDb()
      .prepare(`SELECT * FROM ai_approvals WHERE status IN ('approved','rejected','executed','failed') ORDER BY COALESCE(decided_at, created_at) DESC LIMIT ?`)
      .all(limit) as Row[]
  ).map(toApproval);
}

/** Count of still-pending requests per agent id (for the command-center per-human openApprovals). */
export function countPendingByAgent(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT agent_id, COUNT(*) AS n FROM ai_approvals WHERE status IN ('pending','info_requested','edited') GROUP BY agent_id`)
    .all() as { agent_id: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.agent_id] = r.n;
  return out;
}

// ── Decisions + execution ─────────────────────────────────────────────────────

export interface DecisionResult {
  approval: AiApproval;
  /** Honest outcome of the decision (drives the UI message; never fabricated). */
  outcome:
    | "already_decided" //    idempotent no-op
    | "rejected"
    | "edited"
    | "info_requested"
    | "executed_queued" //    enqueued to the outbox (queued to send, not confirmed delivered)
    | "held_gate_off" //      approved, but the send gate is off — nothing enqueued
    | "held_no_path" //       approved, but no async path exists (SMS)
    | "forbidden" //          approved as intent only — execution not wired in v2
    | "failed"; //            the outbox enqueue itself errored
  message: string;
}

function recordAudit(a: AiApproval, action: string, actor: string, detail: Record<string, unknown>): void {
  try {
    insertAudit({ actor, action, entity: "ai_approval", entityId: a.id, after: { agent: a.agentId, actionType: a.actionType, ...detail } });
  } catch {
    /* audit is best-effort */
  }
}

/** Apply a human decision. APPROVE routes to execution (outbox op / held / forbidden); REJECT / EDIT /
 *  REQUEST MORE INFO just record. Idempotent: deciding a non-decidable request is a no-op. `editedPayload`
 *  (optional) replaces the action payload on an approve-with-edit or an explicit edit. */
export function decideApproval(
  id: string,
  decision: ApprovalDecision,
  actor: string,
  opts: { note?: string; editedPayload?: Record<string, unknown> } = {},
): DecisionResult {
  const db = getDb();
  const current = getApproval(id);
  if (!current) throw new Error("approval not found");

  // Idempotency: once it is no longer decidable, never re-run (never double-execute).
  if (!canDecide(current.status)) {
    return { approval: current, outcome: "already_decided", message: `Already ${current.status}. No change.` };
  }

  const now = new Date().toISOString();
  const payload = opts.editedPayload ?? current.actionPayload;

  // Non-approve decisions: record and return.
  if (decision !== "approve") {
    const next = applyDecision(current.status, decision)!;
    db.prepare("UPDATE ai_approvals SET status=@status, action_payload=@payload, decision_note=@note, decided_by=@by, decided_at=@at WHERE id=@id").run({
      id,
      status: next,
      payload: JSON.stringify(payload),
      note: opts.note ?? null,
      // EDIT keeps the item in the queue and is not a final decision; don't stamp decided_by for it.
      by: decision === "edit" ? current.decidedBy : actor,
      at: decision === "edit" ? current.decidedAt : now,
    });
    recordAudit(current, `APPROVAL_${decision.toUpperCase()}`, actor, { note: opts.note ?? null });
    const out = getApproval(id)!;
    if (decision === "reject") return { approval: out, outcome: "rejected", message: "Rejected. Nothing was sent." };
    if (decision === "edit") return { approval: out, outcome: "edited", message: "Edited. Review and approve when ready." };
    return { approval: out, outcome: "info_requested", message: "Sent back for more info." };
  }

  // APPROVE → route to the existing execution mechanism only.
  const plan = executionPlan(current.actionType);

  if (plan.kind === "forbidden") {
    db.prepare("UPDATE ai_approvals SET status='approved', action_payload=@payload, decision_note=@note, decided_by=@by, decided_at=@at WHERE id=@id").run({
      id, payload: JSON.stringify(payload), note: plan.reason, by: actor, at: now,
    });
    recordAudit(current, "APPROVAL_APPROVED", actor, { executed: false, forbidden: true, reason: plan.reason });
    return { approval: getApproval(id)!, outcome: "forbidden", message: `Approved as intent only. ${plan.reason}` };
  }

  if (plan.kind === "held") {
    db.prepare("UPDATE ai_approvals SET status='approved', action_payload=@payload, decision_note=@note, decided_by=@by, decided_at=@at WHERE id=@id").run({
      id, payload: JSON.stringify(payload), note: plan.reason, by: actor, at: now,
    });
    recordAudit(current, "APPROVAL_APPROVED", actor, { executed: false, held: true, reason: plan.reason });
    return { approval: getApproval(id)!, outcome: "held_no_path", message: `Approved. ${plan.reason}` };
  }

  // Outbox op. Respect the send gate as a SECOND safety: gate off => record the decision, hold the send.
  if (plan.gate && process.env[plan.gate] !== "true") {
    const reason = `${plan.gate} is off. Approved and recorded, but nothing was enqueued — turn the gate on to send.`;
    db.prepare("UPDATE ai_approvals SET status='approved', action_payload=@payload, decision_note=@note, decided_by=@by, decided_at=@at WHERE id=@id").run({
      id, payload: JSON.stringify(payload), note: reason, by: actor, at: now,
    });
    recordAudit(current, "APPROVAL_APPROVED", actor, { executed: false, heldGateOff: plan.gate });
    return { approval: getApproval(id)!, outcome: "held_gate_off", message: reason };
  }

  // Enqueue the proven outbox op. Guard: if already linked, do not re-enqueue (idempotent).
  if (current.outboxOpId) {
    return { approval: current, outcome: "already_decided", message: "Already executed." };
  }
  const { transactionId, opPayload } = buildOutboxPayload(plan.op, payload);
  let opId: string;
  try {
    const op = enqueueGsOp({ op: plan.op, transactionId, label: current.title, payload: opPayload });
    opId = op.id;
  } catch {
    db.prepare("UPDATE ai_approvals SET status='failed', decision_note='Failed to enqueue the outbox op.', decided_by=@by, decided_at=@at WHERE id=@id").run({ id, by: actor, at: now });
    recordAudit(current, "APPROVAL_FAILED", actor, { reason: "enqueue_failed" });
    return { approval: getApproval(id)!, outcome: "failed", message: "Could not enqueue the action." };
  }
  const note = "Queued to the Goodshuffle outbox. It sends on the next office Auto-Pull cycle (queued, not yet confirmed delivered).";
  db.prepare("UPDATE ai_approvals SET status='executed', action_payload=@payload, outbox_op_id=@op, decision_note=@note, decided_by=@by, decided_at=@at WHERE id=@id").run({
    id, payload: JSON.stringify(payload), op: opId, note, by: actor, at: now,
  });
  recordAudit(current, "APPROVAL_EXECUTED", actor, { executed: true, op: plan.op, outboxOpId: opId });
  return { approval: getApproval(id)!, outcome: "executed_queued", message: note };
}
