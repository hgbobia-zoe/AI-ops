// WS05 — persistence for the exception-resolution record. Thin DB glue over the exception_resolutions
// table (created in the SCHEMA string). The DEDUP discipline lives here: upsertException is keyed by
// `<source>:<sourceId>`, so a repeated scan of the same underlying problem updates the row in place and
// NEVER inserts a second record (mission acceptance #3). All mutation is through setFields; the engine
// decides WHAT to write, this module only writes it.

import { getDb } from "@/lib/db";
import {
  exceptionKey,
  type CanonicalException,
  type EscalationTier,
  type ExceptionResolution,
  type OwnerRole,
  type ResolutionStatus,
  OPEN_STATUSES,
} from "./types";

interface Row {
  key: string;
  source: string;
  source_id: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  detail: string | null;
  assigned_role: string | null;
  next_action: string | null;
  deadline: string | null;
  approval_id: string | null;
  resolve_attempts: number;
  last_attempt_at: string | null;
  escalation_tier: string;
  escalated_at: string | null;
  verification_evidence: string | null;
  disposition: string | null;
  disposed_by: string | null;
  first_detected_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

function toResolution(r: Row): ExceptionResolution {
  let evidence: Record<string, unknown> | null = null;
  try {
    evidence = r.verification_evidence ? (JSON.parse(r.verification_evidence) as Record<string, unknown>) : null;
  } catch {
    evidence = null;
  }
  return {
    key: r.key,
    source: r.source as ExceptionResolution["source"],
    sourceId: r.source_id,
    type: r.type,
    severity: r.severity as ExceptionResolution["severity"],
    status: r.status as ResolutionStatus,
    title: r.title,
    detail: r.detail,
    assignedRole: (r.assigned_role as OwnerRole | null) ?? null,
    nextAction: r.next_action,
    deadline: r.deadline,
    approvalId: r.approval_id,
    resolveAttempts: r.resolve_attempts,
    lastAttemptAt: r.last_attempt_at,
    escalationTier: r.escalation_tier as EscalationTier,
    escalatedAt: r.escalated_at,
    verificationEvidence: evidence,
    disposition: r.disposition,
    disposedBy: r.disposed_by,
    firstDetectedAt: r.first_detected_at,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}

export function getException(key: string): ExceptionResolution | null {
  const r = getDb().prepare("SELECT * FROM exception_resolutions WHERE key = ?").get(key) as Row | undefined;
  return r ? toResolution(r) : null;
}

export interface UpsertResult {
  resolution: ExceptionResolution;
  isNew: boolean;
}

/**
 * Insert a freshly-detected exception as `active`, OR — if it already exists — refresh only its volatile
 * descriptive fields (severity/title/detail/deadline/last_seen_at) WITHOUT touching its coordination state
 * (status/approval/escalation). This is the dedup choke point: the same `<source>:<sourceId>` is one row
 * forever. A row that was already closed (resolved/disposed) is NOT reopened by a re-detect — only its
 * last_seen_at advances, so a human disposition sticks.
 */
export function upsertException(e: CanonicalException, now: Date = new Date()): UpsertResult {
  const db = getDb();
  const key = exceptionKey(e);
  const existing = db.prepare("SELECT * FROM exception_resolutions WHERE key = ?").get(key) as Row | undefined;
  const nowIso = now.toISOString();
  const firstSeen = e.firstDetectedAt && Number.isFinite(Date.parse(e.firstDetectedAt)) ? e.firstDetectedAt : nowIso;

  if (existing) {
    db.prepare(
      `UPDATE exception_resolutions
         SET severity = @severity, title = @title, detail = @detail, deadline = @deadline,
             last_seen_at = @now, updated_at = @now
       WHERE key = @key`,
    ).run({ key, severity: e.severity, title: e.title, detail: e.detail, deadline: e.deadline ?? null, now: nowIso });
    return { resolution: getException(key)!, isNew: false };
  }

  db.prepare(
    `INSERT INTO exception_resolutions
       (key, source, source_id, type, severity, status, title, detail, deadline,
        resolve_attempts, escalation_tier, first_detected_at, last_seen_at, created_at, updated_at)
     VALUES
       (@key, @source, @sourceId, @type, @severity, 'active', @title, @detail, @deadline,
        0, 'none', @firstSeen, @now, @now, @now)`,
  ).run({
    key,
    source: e.source,
    sourceId: e.sourceId,
    type: e.type,
    severity: e.severity,
    title: e.title,
    detail: e.detail,
    deadline: e.deadline ?? null,
    firstSeen,
    now: nowIso,
  });
  return { resolution: getException(key)!, isNew: true };
}

/** The volatile coordination fields the engine updates. Any omitted field is left unchanged. */
export interface ExceptionPatch {
  status?: ResolutionStatus;
  assignedRole?: OwnerRole | null;
  nextAction?: string | null;
  approvalId?: string | null;
  resolveAttempts?: number;
  lastAttemptAt?: string | null;
  escalationTier?: EscalationTier;
  escalatedAt?: string | null;
  verificationEvidence?: Record<string, unknown> | null;
  disposition?: string | null;
  disposedBy?: string | null;
  resolvedAt?: string | null;
}

/** Patch a resolution's coordination fields. Always bumps updated_at. */
export function setFields(key: string, patch: ExceptionPatch, now: Date = new Date()): ExceptionResolution | null {
  const existing = getException(key);
  if (!existing) return null;
  const nowIso = now.toISOString();
  const next = {
    status: patch.status ?? existing.status,
    assigned_role: patch.assignedRole !== undefined ? patch.assignedRole : existing.assignedRole,
    next_action: patch.nextAction !== undefined ? patch.nextAction : existing.nextAction,
    approval_id: patch.approvalId !== undefined ? patch.approvalId : existing.approvalId,
    resolve_attempts: patch.resolveAttempts ?? existing.resolveAttempts,
    last_attempt_at: patch.lastAttemptAt !== undefined ? patch.lastAttemptAt : existing.lastAttemptAt,
    escalation_tier: patch.escalationTier ?? existing.escalationTier,
    escalated_at: patch.escalatedAt !== undefined ? patch.escalatedAt : existing.escalatedAt,
    verification_evidence:
      patch.verificationEvidence !== undefined
        ? patch.verificationEvidence
          ? JSON.stringify(patch.verificationEvidence)
          : null
        : existing.verificationEvidence
          ? JSON.stringify(existing.verificationEvidence)
          : null,
    disposition: patch.disposition !== undefined ? patch.disposition : existing.disposition,
    disposed_by: patch.disposedBy !== undefined ? patch.disposedBy : existing.disposedBy,
    resolved_at: patch.resolvedAt !== undefined ? patch.resolvedAt : existing.resolvedAt,
  };
  getDb()
    .prepare(
      `UPDATE exception_resolutions SET
         status = @status, assigned_role = @assigned_role, next_action = @next_action, approval_id = @approval_id,
         resolve_attempts = @resolve_attempts, last_attempt_at = @last_attempt_at, escalation_tier = @escalation_tier,
         escalated_at = @escalated_at, verification_evidence = @verification_evidence, disposition = @disposition,
         disposed_by = @disposed_by, resolved_at = @resolved_at, updated_at = @now
       WHERE key = @key`,
    )
    .run({ key, now: nowIso, ...next });
  return getException(key);
}

/** All OPEN exceptions (not resolved/disposed), worst severity first. */
export function listOpenExceptions(): ExceptionResolution[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM exception_resolutions
        WHERE status NOT IN ('resolved','disposed')
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 first_detected_at ASC`,
    )
    .all() as Row[];
  return rows.map(toResolution);
}

/** Every resolution currently in an OPEN state whose key is in the given set — used to find exceptions whose
 *  source signal has DISAPPEARED (key NOT in the freshly-detected set). */
export function listOpenNotIn(detectedKeys: ReadonlySet<string>): ExceptionResolution[] {
  return listOpenExceptions().filter((r) => OPEN_STATUSES.has(r.status) && !detectedKeys.has(r.key));
}

export interface ExceptionSummary {
  active: number;
  delegated: number;
  awaitingApproval: number;
  acting: number;
  escalated: number;
  failed: number;
  unverifiable: number;
  resolved: number;
  disposed: number;
  total: number;
}

/** Counts by status — the honest UI/Slack summary (mission acceptance #7). */
export function exceptionSummary(): ExceptionSummary {
  const rows = getDb().prepare("SELECT status, COUNT(*) AS n FROM exception_resolutions GROUP BY status").all() as {
    status: string;
    n: number;
  }[];
  const by: Record<string, number> = {};
  for (const r of rows) by[r.status] = r.n;
  return {
    active: by.active ?? 0,
    delegated: by.delegated ?? 0,
    awaitingApproval: by.awaiting_approval ?? 0,
    acting: by.acting ?? 0,
    escalated: by.escalated ?? 0,
    failed: by.failed ?? 0,
    unverifiable: by.unverifiable ?? 0,
    resolved: by.resolved ?? 0,
    disposed: by.disposed ?? 0,
    total: Object.values(by).reduce((a, b) => a + b, 0),
  };
}
