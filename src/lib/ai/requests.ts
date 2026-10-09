// AI Control Plane — the Requests backlog store. A REQUEST is a human ask captured from an AI session that
// is a product/feature idea ("the app should do X"), a question, or an operational task, filed so it is
// TRACKED rather than lost in a session timeline. The bridge responder classifies each instruction and
// files feature requests here; a request can later graduate to an implementation PR.
//
// Governing law holds: nothing in this module executes a production change. A request is a record; its
// implementation reaches production only when a human MERGES the PR it links to, and any operational data
// write still goes through ai_approvals. Typed data access over ai_requests, mirroring sessions.ts.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { insertAudit } from "@/lib/db/repo";

// ── Types ─────────────────────────────────────────────────────────────────────
export type AiRequestType = "feature" | "question" | "operational";
export type AiRequestStatus = "new" | "triaged" | "in_progress" | "in_review" | "done" | "declined";

export const REQUEST_TYPES: AiRequestType[] = ["feature", "question", "operational"];
export const REQUEST_STATUSES: AiRequestStatus[] = ["new", "triaged", "in_progress", "in_review", "done", "declined"];
const TERMINAL_STATUSES: AiRequestStatus[] = ["done", "declined"];

export interface NewRequest {
  sessionId?: string | null;
  blade?: string | null;
  requestedBy?: string | null;
  title: string;
  body?: string | null;
  type: AiRequestType;
  /** Re-filing the same instruction is a no-op when this key already exists (e.g. "req:"+instructionEventId). */
  changeKey?: string;
}

export interface AiRequest {
  id: string;
  sessionId: string | null;
  blade: string | null;
  requestedBy: string | null;
  title: string;
  body: string | null;
  type: AiRequestType;
  status: AiRequestStatus;
  prUrl: string | null;
  prNumber: number | null;
  branch: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Pure helpers (no DB — unit-tested) ─────────────────────────────────────────

/** Is this request closed (done/declined)? PURE. */
export function isRequestTerminal(status: AiRequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** The status implied when a request gets an implementation PR attached: in_review (awaiting the human
 *  merge), unless it is already closed (then unchanged). PURE. */
export function statusForPrAttached(current: AiRequestStatus): AiRequestStatus {
  return isRequestTerminal(current) ? current : "in_review";
}

// ── Row shape + mapper ──────────────────────────────────────────────────────────
interface RequestRow {
  id: string;
  session_id: string | null;
  blade: string | null;
  requested_by: string | null;
  title: string;
  body: string | null;
  type: string;
  status: string;
  pr_url: string | null;
  pr_number: number | null;
  branch: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function toRequest(r: RequestRow): AiRequest {
  return {
    id: r.id,
    sessionId: r.session_id,
    blade: r.blade,
    requestedBy: r.requested_by,
    title: r.title,
    body: r.body,
    type: r.type as AiRequestType,
    status: r.status as AiRequestStatus,
    prUrl: r.pr_url,
    prNumber: r.pr_number,
    branch: r.branch,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────────

/** File a request. Idempotent on changeKey: re-filing the same instruction returns the existing row rather
 *  than duplicating. New requests start `new`. Writes a best-effort audit row. */
export function createRequest(input: NewRequest): AiRequest {
  const db = getDb();
  if (input.changeKey) {
    const existing = db.prepare("SELECT * FROM ai_requests WHERE change_key = ?").get(input.changeKey) as RequestRow | undefined;
    if (existing) return toRequest(existing);
  }
  const title = input.title.trim();
  if (!title) throw new Error("createRequest: title required");
  const id = `REQ-${randomUUID()}`;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO ai_requests (id, session_id, blade, requested_by, title, body, type, status, change_key, created_at, updated_at)
       VALUES (@id, @sessionId, @blade, @requestedBy, @title, @body, @type, 'new', @changeKey, @now, @now)`,
    ).run({
      id,
      sessionId: input.sessionId ?? null,
      blade: input.blade ?? null,
      requestedBy: input.requestedBy ?? null,
      title,
      body: input.body?.trim() || null,
      type: input.type,
      changeKey: input.changeKey ?? null,
      now,
    });
  } catch {
    if (input.changeKey) {
      const raced = db.prepare("SELECT * FROM ai_requests WHERE change_key = ?").get(input.changeKey) as RequestRow | undefined;
      if (raced) return toRequest(raced);
    }
    throw new Error("createRequest failed");
  }
  recordAudit(id, "AI_REQUEST_FILED", input.requestedBy ?? "AI responder", { type: input.type, blade: input.blade ?? null, sessionId: input.sessionId ?? null });
  return toRequest(db.prepare("SELECT * FROM ai_requests WHERE id = ?").get(id) as RequestRow);
}

/** Change a request's status (triage, decline, mark done…). Records notes + an audit row. No-op if missing. */
export function setRequestStatus(id: string, status: AiRequestStatus, opts: { notes?: string; actor?: string } = {}): AiRequest | null {
  const db = getDb();
  const cur = db.prepare("SELECT * FROM ai_requests WHERE id = ?").get(id) as RequestRow | undefined;
  if (!cur) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE ai_requests SET status=@status, notes=COALESCE(@notes, notes), updated_at=@now WHERE id=@id").run({
    id,
    status,
    notes: opts.notes?.trim() || null,
    now,
  });
  recordAudit(id, "AI_REQUEST_STATUS", opts.actor ?? "system", { from: cur.status, to: status });
  return toRequest(db.prepare("SELECT * FROM ai_requests WHERE id = ?").get(id) as RequestRow);
}

/** Attach an implementation PR to a request and move it to in_review (awaiting the human merge). The merge
 *  itself is the approval; this never merges or deploys. No-op if the request is missing or already closed. */
export function attachRequestPr(id: string, pr: { url: string; number?: number; branch?: string }, actor?: string): AiRequest | null {
  const db = getDb();
  const cur = db.prepare("SELECT * FROM ai_requests WHERE id = ?").get(id) as RequestRow | undefined;
  if (!cur) return null;
  const next = statusForPrAttached(cur.status as AiRequestStatus);
  const now = new Date().toISOString();
  db.prepare("UPDATE ai_requests SET pr_url=@url, pr_number=@number, branch=@branch, status=@status, updated_at=@now WHERE id=@id").run({
    id,
    url: pr.url,
    number: pr.number ?? null,
    branch: pr.branch ?? null,
    status: next,
    now,
  });
  recordAudit(id, "AI_REQUEST_PR_ATTACHED", actor ?? "AI responder", { prUrl: pr.url, prNumber: pr.number ?? null });
  return toRequest(db.prepare("SELECT * FROM ai_requests WHERE id = ?").get(id) as RequestRow);
}

// ── Reads ───────────────────────────────────────────────────────────────────────

export function getRequest(id: string): AiRequest | null {
  const r = getDb().prepare("SELECT * FROM ai_requests WHERE id = ?").get(id) as RequestRow | undefined;
  return r ? toRequest(r) : null;
}

/** Requests, newest first, optionally filtered by status and/or type. */
export function listRequests(opts: { status?: AiRequestStatus; type?: AiRequestType; limit?: number } = {}): AiRequest[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 200 };
  if (opts.status) { where.push("status = @status"); params.status = opts.status; }
  if (opts.type) { where.push("type = @type"); params.type = opts.type; }
  const sql = `SELECT * FROM ai_requests ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT @limit`;
  return (getDb().prepare(sql).all(params) as RequestRow[]).map(toRequest);
}

/** Open requests = everything not done/declined, newest first (the active backlog). */
export function listOpenRequests(limit = 200): AiRequest[] {
  return (
    getDb().prepare("SELECT * FROM ai_requests WHERE status NOT IN ('done','declined') ORDER BY created_at DESC LIMIT ?").all(limit) as RequestRow[]
  ).map(toRequest);
}

/** Count of requests per status (for the Requests view header + nav badge). */
export function countRequestsByStatus(): Record<AiRequestStatus, number> {
  const rows = getDb().prepare("SELECT status, COUNT(*) AS n FROM ai_requests GROUP BY status").all() as { status: string; n: number }[];
  const out = { new: 0, triaged: 0, in_progress: 0, in_review: 0, done: 0, declined: 0 } as Record<AiRequestStatus, number>;
  for (const r of rows) if (r.status in out) out[r.status as AiRequestStatus] = r.n;
  return out;
}

/** Count of open (actionable) requests — for the in-app nav badge. */
export function countOpenRequests(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM ai_requests WHERE status NOT IN ('done','declined')").get() as { n: number };
  return row.n;
}

// ── Audit (best-effort) ─────────────────────────────────────────────────────────
function recordAudit(requestId: string, action: string, actor: string, detail: Record<string, unknown>): void {
  try {
    insertAudit({ actor, action, entity: "ai_request", entityId: requestId, after: detail });
  } catch {
    /* audit is best-effort */
  }
}
