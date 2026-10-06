// AI Control Plane — the session store. A SESSION is one bounded unit of AI work (an agent run, or an
// interactive workspace turn) scoped to a blade + agent + human owner. This module is the typed data
// access over ai_sessions / ai_session_events / ai_session_tools / ai_session_approvals, mirroring the
// approvals.ts idiom (Row interface → to*() camelCase mapper → prepared-statement functions).
//
// Governing law holds: RULES CALCULATE, AI INTERPRETS. A session RECORDS what the AI read, reasoned and
// drafted; it NEVER writes operational data itself. Any mutation a session proposes is created as an
// ai_approvals row (via createApproval) and linked here with linkSessionApproval — the approval, decided
// by a human, is the only thing that reaches the gs_outbox execution path. Nothing in this file executes
// a side effect, calls a provider, or touches a secret.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { insertAudit } from "@/lib/db/repo";

// ── Types ─────────────────────────────────────────────────────────────────────
export type SessionStatus = "running" | "awaiting_approval" | "done" | "failed" | "cancelled";

/** The kind of a timeline event. Append-only; every step the session takes is one row. */
export type SessionEventKind =
  | "started"
  | "step"
  | "tool_call"
  | "message"
  | "state_change"
  | "approval_raised"
  | "finished"
  | "error";

export type ToolRunStatus = "ok" | "error";

export interface NewSession {
  agentId: string;
  /** Originating blade (BladeKey), or undefined for a cross-blade session. */
  blade?: string;
  owner?: string;
  startedBy?: string;
  title: string;
  /** The AIProvider adapter id that backs this run (audit only — never a secret). */
  provider?: string;
  input?: Record<string, unknown>;
  /** Re-opening the same logical run is a no-op when this key already exists. */
  idempotencyKey?: string;
}

export interface AiSession {
  id: string;
  agentId: string;
  blade: string | null;
  owner: string | null;
  startedBy: string | null;
  title: string;
  status: SessionStatus;
  provider: string | null;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface AiSessionEvent {
  id: string;
  sessionId: string;
  ts: string;
  actor: string | null;
  kind: SessionEventKind;
  label: string | null;
  payload: Record<string, unknown> | null;
}

export interface AiSessionTool {
  id: string;
  sessionId: string;
  toolId: string;
  category: string | null;
  perm: string | null;
  args: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  status: ToolRunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// ── Pure helpers (no DB — unit-tested) ─────────────────────────────────────────

const LIVE: SessionStatus[] = ["running", "awaiting_approval"];
const TERMINAL: SessionStatus[] = ["done", "failed", "cancelled"];

/** Is this session still open (can take events / be ended)? Terminal states are closed. PURE. */
export function isSessionLive(status: SessionStatus): boolean {
  return LIVE.includes(status);
}

/** Is this a final, no-further-change state? PURE. */
export function isSessionTerminal(status: SessionStatus): boolean {
  return TERMINAL.includes(status);
}

/** The next status when a session ends with an outcome, or null if it is already terminal (idempotent
 *  no-op). Only a live session can transition to a terminal state. PURE. */
export function endStatusFor(
  current: SessionStatus,
  outcome: "done" | "failed" | "cancelled",
): SessionStatus | null {
  if (isSessionTerminal(current)) return null;
  return outcome;
}

function safeObj(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Row shapes + mappers ────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  agent_id: string;
  blade: string | null;
  owner: string | null;
  started_by: string | null;
  title: string;
  status: string;
  provider: string | null;
  input_json: string | null;
  result_json: string | null;
  error: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

function toSession(r: SessionRow): AiSession {
  return {
    id: r.id,
    agentId: r.agent_id,
    blade: r.blade,
    owner: r.owner,
    startedBy: r.started_by,
    title: r.title,
    status: r.status as SessionStatus,
    provider: r.provider,
    input: safeObj(r.input_json),
    result: r.result_json ? safeObj(r.result_json) : null,
    error: r.error,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
  };
}

interface EventRow {
  id: string;
  session_id: string;
  ts: string;
  actor: string | null;
  kind: string;
  label: string | null;
  payload: string | null;
  change_key: string | null;
}

function toEvent(r: EventRow): AiSessionEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    ts: r.ts,
    actor: r.actor,
    kind: r.kind as SessionEventKind,
    label: r.label,
    payload: r.payload ? safeObj(r.payload) : null,
  };
}

interface ToolRow {
  id: string;
  session_id: string;
  tool_id: string;
  category: string | null;
  perm: string | null;
  args_json: string | null;
  result_json: string | null;
  status: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

function toTool(r: ToolRow): AiSessionTool {
  return {
    id: r.id,
    sessionId: r.session_id,
    toolId: r.tool_id,
    category: r.category,
    perm: r.perm,
    args: r.args_json ? safeObj(r.args_json) : null,
    result: r.result_json ? safeObj(r.result_json) : null,
    status: r.status as ToolRunStatus,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

/** Open a session, idempotently. If the idempotency key already exists the existing row is returned
 *  unchanged (re-opening the same logical run never duplicates). Writes a `started` timeline event. */
export function createSession(input: NewSession): AiSession {
  const db = getDb();
  if (input.idempotencyKey) {
    const existing = db.prepare("SELECT * FROM ai_sessions WHERE idempotency_key = ?").get(input.idempotencyKey) as SessionRow | undefined;
    if (existing) return toSession(existing);
  }
  const id = `AS-${randomUUID()}`;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO ai_sessions (id, agent_id, blade, owner, started_by, title, status, provider,
        input_json, idempotency_key, created_at, updated_at)
       VALUES (@id, @agentId, @blade, @owner, @startedBy, @title, 'running', @provider,
        @input, @key, @now, @now)`,
    ).run({
      id,
      agentId: input.agentId,
      blade: input.blade ?? null,
      owner: input.owner ?? null,
      startedBy: input.startedBy ?? null,
      title: input.title,
      provider: input.provider ?? null,
      input: JSON.stringify(input.input ?? {}),
      key: input.idempotencyKey ?? null,
      now,
    });
  } catch {
    if (input.idempotencyKey) {
      const raced = db.prepare("SELECT * FROM ai_sessions WHERE idempotency_key = ?").get(input.idempotencyKey) as SessionRow | undefined;
      if (raced) return toSession(raced);
    }
    throw new Error("createSession failed");
  }
  appendEvent(id, { kind: "started", actor: input.startedBy ?? null, label: input.title });
  recordAudit(id, "AI_SESSION_STARTED", input.startedBy ?? "system", { agent: input.agentId, blade: input.blade ?? null, provider: input.provider ?? null });
  return toSession(db.prepare("SELECT * FROM ai_sessions WHERE id = ?").get(id) as SessionRow);
}

export function getSession(id: string): AiSession | null {
  const r = getDb().prepare("SELECT * FROM ai_sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return r ? toSession(r) : null;
}

/** Live sessions (running + awaiting_approval), newest first. */
export function listLiveSessions(limit = 100): AiSession[] {
  return (
    getDb()
      .prepare(`SELECT * FROM ai_sessions WHERE status IN ('running','awaiting_approval') ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as SessionRow[]
  ).map(toSession);
}

/** Recent sessions regardless of status, newest first (the Command Center feed). */
export function listRecentSessions(limit = 100): AiSession[] {
  return (getDb().prepare(`SELECT * FROM ai_sessions ORDER BY created_at DESC LIMIT ?`).all(limit) as SessionRow[]).map(toSession);
}

/** Sessions for one blade, newest first (the per-blade AI workspace). */
export function listSessionsForBlade(blade: string, limit = 50): AiSession[] {
  return (
    getDb().prepare(`SELECT * FROM ai_sessions WHERE blade = ? ORDER BY created_at DESC LIMIT ?`).all(blade, limit) as SessionRow[]
  ).map(toSession);
}

/** Sessions for one agent, newest first. */
export function listSessionsForAgent(agentId: string, limit = 50): AiSession[] {
  return (
    getDb().prepare(`SELECT * FROM ai_sessions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`).all(agentId, limit) as SessionRow[]
  ).map(toSession);
}

/** Count of live sessions per blade (for the Command Center / per-blade strip). */
export function countLiveSessionsByBlade(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT blade, COUNT(*) AS n FROM ai_sessions WHERE status IN ('running','awaiting_approval') AND blade IS NOT NULL GROUP BY blade`)
    .all() as { blade: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.blade] = r.n;
  return out;
}

/** Count of live sessions per agent id. */
export function countLiveSessionsByAgent(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT agent_id, COUNT(*) AS n FROM ai_sessions WHERE status IN ('running','awaiting_approval') GROUP BY agent_id`)
    .all() as { agent_id: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.agent_id] = r.n;
  return out;
}

/** Mark a session as awaiting a human approval (it raised a proposal). Idempotent: a terminal session
 *  is not reopened. Writes a `state_change` event. */
export function markAwaitingApproval(id: string, actor?: string): AiSession | null {
  const cur = getSession(id);
  if (!cur) return null;
  if (isSessionTerminal(cur.status)) return cur;
  const now = new Date().toISOString();
  getDb().prepare("UPDATE ai_sessions SET status='awaiting_approval', updated_at=@now WHERE id=@id").run({ id, now });
  appendEvent(id, { kind: "state_change", actor: actor ?? null, label: "Awaiting approval" });
  return getSession(id);
}

/** End a session with an outcome. Idempotent: ending an already-terminal session is a no-op. Writes a
 *  `finished` (or `error`) timeline event and an audit row. `result` is the interpreted output; `error`
 *  the honest failure reason when outcome=failed. */
export function endSession(
  id: string,
  outcome: "done" | "failed" | "cancelled",
  opts: { result?: Record<string, unknown>; error?: string; actor?: string } = {},
): AiSession | null {
  const db = getDb();
  const cur = getSession(id);
  if (!cur) return null;
  const next = endStatusFor(cur.status, outcome);
  if (!next) return cur; // already terminal — idempotent no-op
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE ai_sessions SET status=@status, result_json=@result, error=@error, updated_at=@now, ended_at=@now WHERE id=@id",
  ).run({
    id,
    status: next,
    result: opts.result ? JSON.stringify(opts.result) : cur.result ? JSON.stringify(cur.result) : null,
    error: outcome === "failed" ? opts.error ?? "unspecified failure" : null,
    now,
  });
  appendEvent(id, {
    kind: outcome === "failed" ? "error" : "finished",
    actor: opts.actor ?? null,
    label: outcome === "failed" ? opts.error ?? "Failed" : outcome === "cancelled" ? "Cancelled" : "Done",
  });
  recordAudit(id, `AI_SESSION_${outcome.toUpperCase()}`, opts.actor ?? "system", { agent: cur.agentId });
  return getSession(id);
}

/** Store/replace the session's interpreted result without ending it (e.g. a workspace turn's analysis). */
export function setSessionResult(id: string, result: Record<string, unknown>): AiSession | null {
  const cur = getSession(id);
  if (!cur) return null;
  const now = new Date().toISOString();
  getDb().prepare("UPDATE ai_sessions SET result_json=@result, updated_at=@now WHERE id=@id").run({ id, result: JSON.stringify(result), now });
  return getSession(id);
}

// ── Events (append-only timeline) ──────────────────────────────────────────────

/** Append one timeline event to a session. `changeKey` (optional) makes replayed ingest idempotent. */
export function appendEvent(
  sessionId: string,
  ev: { kind: SessionEventKind; actor?: string | null; label?: string | null; payload?: Record<string, unknown>; changeKey?: string },
): AiSessionEvent | null {
  const db = getDb();
  const id = `AE-${randomUUID()}`;
  const ts = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO ai_session_events (id, session_id, ts, actor, kind, label, payload, change_key)
       VALUES (@id, @sessionId, @ts, @actor, @kind, @label, @payload, @changeKey)`,
    ).run({
      id,
      sessionId,
      ts,
      actor: ev.actor ?? null,
      kind: ev.kind,
      label: ev.label ?? null,
      payload: ev.payload ? JSON.stringify(ev.payload) : null,
      changeKey: ev.changeKey ?? null,
    });
  } catch {
    // UNIQUE change_key race / duplicate replay — the event already exists, which is the intended no-op.
    return null;
  }
  // Keep updated_at fresh so the feed sorts sensibly, but don't resurrect a terminal session's status.
  db.prepare("UPDATE ai_sessions SET updated_at=@ts WHERE id=@sessionId").run({ ts, sessionId });
  return toEvent(db.prepare("SELECT * FROM ai_session_events WHERE id = ?").get(id) as EventRow);
}

/** The timeline for a session, newest first. */
export function listSessionEvents(sessionId: string, limit = 200): AiSessionEvent[] {
  return (
    // rowid DESC is the tie-break so events written within the same millisecond still sort newest-first.
    getDb().prepare(`SELECT * FROM ai_session_events WHERE session_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?`).all(sessionId, limit) as EventRow[]
  ).map(toEvent);
}

// ── Tool runs ───────────────────────────────────────────────────────────────

/** Record a tool invocation on a session (observability only — a mutating tool goes through an approval,
 *  not here). Also writes a `tool_call` timeline event. */
export function recordToolRun(
  sessionId: string,
  run: {
    toolId: string;
    category?: string;
    perm?: string;
    args?: Record<string, unknown>;
    result?: Record<string, unknown>;
    status: ToolRunStatus;
    error?: string;
  },
): AiSessionTool {
  const db = getDb();
  const id = `AT-${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ai_session_tools (id, session_id, tool_id, category, perm, args_json, result_json, status, error, started_at, finished_at)
     VALUES (@id, @sessionId, @toolId, @category, @perm, @args, @result, @status, @error, @now, @finished)`,
  ).run({
    id,
    sessionId,
    toolId: run.toolId,
    category: run.category ?? null,
    perm: run.perm ?? null,
    args: run.args ? JSON.stringify(run.args) : null,
    result: run.result ? JSON.stringify(run.result) : null,
    status: run.status,
    error: run.error ?? null,
    now,
    finished: now,
  });
  appendEvent(sessionId, {
    kind: "tool_call",
    label: `${run.toolId}${run.status === "error" ? " (error)" : ""}`,
    payload: { toolId: run.toolId, status: run.status },
  });
  return toTool(db.prepare("SELECT * FROM ai_session_tools WHERE id = ?").get(id) as ToolRow);
}

/** Tool runs for a session, oldest first (execution order). */
export function listSessionTools(sessionId: string, limit = 200): AiSessionTool[] {
  return (
    // rowid ASC tie-break keeps oldest-first stable when started_at collides on the millisecond.
    getDb().prepare(`SELECT * FROM ai_session_tools WHERE session_id = ? ORDER BY started_at, rowid LIMIT ?`).all(sessionId, limit) as ToolRow[]
  ).map(toTool);
}

// ── Approval links ─────────────────────────────────────────────────────────────

/** Tie an ai_approvals row (created via createApproval) to the session that proposed it. Idempotent on
 *  (session_id, approval_id). Also flips the session to awaiting_approval and logs an `approval_raised`
 *  event — the approval itself remains the single source of truth for the action's lifecycle. */
export function linkSessionApproval(sessionId: string, approvalId: string, actor?: string): void {
  const db = getDb();
  const id = `AX-${randomUUID()}`;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO ai_session_approvals (id, session_id, approval_id, created_at) VALUES (@id, @sessionId, @approvalId, @now)`,
    ).run({ id, sessionId, approvalId, now });
  } catch {
    return; // already linked — idempotent no-op
  }
  appendEvent(sessionId, { kind: "approval_raised", actor: actor ?? null, label: "Proposed an action for approval", payload: { approvalId } });
  markAwaitingApproval(sessionId, actor);
}

/** The ai_approvals ids a session has raised. */
export function listSessionApprovalIds(sessionId: string): string[] {
  return (
    getDb().prepare(`SELECT approval_id FROM ai_session_approvals WHERE session_id = ? ORDER BY created_at`).all(sessionId) as {
      approval_id: string;
    }[]
  ).map((r) => r.approval_id);
}

// ── Audit (best-effort) ─────────────────────────────────────────────────────────

function recordAudit(sessionId: string, action: string, actor: string, detail: Record<string, unknown>): void {
  try {
    insertAudit({ actor, action, entity: "ai_session", entityId: sessionId, after: detail });
  } catch {
    /* audit is best-effort */
  }
}
