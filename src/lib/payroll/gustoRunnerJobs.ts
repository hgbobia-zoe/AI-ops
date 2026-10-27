// Gusto DRAFT hours PUSH — the in-app remote-browser JOB QUEUE store. A JOB is one approved push: the exact
// per-worker hours (built server-side by the owner/admin-gated builder, NOT here) to write into the current
// Gusto DRAFT run. The app only RECORDS the job; the office-machine runner (tools/gusto-runner — a persistent
// Playwright browser on a residential IP, already logged into Gusto) claims it, drives the draft run, replays
// AutoSaveWorkedHours per worker (DRAFT-ONLY), and streams a live screenshot + per-worker results back. This
// lets a payroll person with NO browser extension push hours from the app and watch the remote browser.
//
// Governing law: a PURE state machine over `gusto_push_jobs` + thin DB access. It NEVER throws into its
// callers — every function returns a value or null and swallows DB faults (mirrors src/lib/website/jobs.ts).
// The state machine:
//   createJob        → queued
//   claimNextQueued  → queued   → claimed            (single assignment: one runner claims a given job)
//   reportProgress   → active   → signin_required | pushing  (phase/screenshot/partial results as it goes)
//   completeJob      → active   → done               (final workers[] + sessionMode; `aborted` for a clean bail)
//   failJob          → active   → failed             (error)
//   cancelJob        → queued|active → canceled       (a human stops it from the app)
// "active" = claimed | signin_required | pushing.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { GustoPushWorkerResult } from "@/lib/payroll/gustoPushState";
import type { GustoPushEntry } from "@/lib/payroll/gustoPush";

// Re-export so the job store is the single import site for "a push job + its entries".
export type { GustoPushEntry };

// ── Types ─────────────────────────────────────────────────────────────────────
export type GustoPushJobStatus =
  | "queued"
  | "claimed"
  | "signin_required"
  | "pushing"
  | "done"
  | "failed"
  | "canceled";

/** The active (not-yet-terminal) states a running job passes through. */
const ACTIVE: GustoPushJobStatus[] = ["claimed", "signin_required", "pushing"];
const ACTIVE_SQL = "('claimed','signin_required','pushing')";

export interface GustoPushJob {
  id: string;
  which: "current" | "previous";
  periodStart: string | null;
  periodEnd: string | null;
  periodLabel: string | null;
  entries: GustoPushEntry[];
  requester: string | null;
  status: GustoPushJobStatus;
  phase: string | null;
  draftPayrollId: string | null;
  sessionMode: "captured" | "generated" | null;
  workers: GustoPushWorkerResult[];
  /** Latest live screenshot basename on the volume (served by the authed screenshot route); null until first frame. */
  screenshot: string | null;
  error: string | null;
  aborted: string | null;
  canceledBy: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
}

// ── Row shape + mapper ──────────────────────────────────────────────────────────
interface JobRow {
  id: string;
  which: string;
  period_start: string | null;
  period_end: string | null;
  period_label: string | null;
  entries: string;
  requester: string | null;
  status: string;
  phase: string | null;
  draft_payroll_id: string | null;
  session_mode: string | null;
  workers: string | null;
  screenshot: string | null;
  error: string | null;
  aborted: string | null;
  canceled_by: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  finished_at: string | null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseEntries(json: string | null): GustoPushEntry[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        gustoMemberId: String(x.gustoMemberId ?? ""),
        name: String(x.name ?? ""),
        regularHours: num(x.regularHours),
        overtimeHours: num(x.overtimeHours),
        doubleOvertimeHours: num(x.doubleOvertimeHours),
      }))
      .filter((e) => e.gustoMemberId);
  } catch {
    return [];
  }
}

function parseWorkers(json: string | null): GustoPushWorkerResult[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        gustoMemberId: String(x.gustoMemberId ?? ""),
        name: typeof x.name === "string" ? x.name : null,
        outcome: (x.outcome === "pushed" || x.outcome === "skipped" || x.outcome === "failed" ? x.outcome : "skipped") as GustoPushWorkerResult["outcome"],
        regularHours: typeof x.regularHours === "number" ? x.regularHours : null,
        overtimeHours: typeof x.overtimeHours === "number" ? x.overtimeHours : null,
        reason: typeof x.reason === "string" ? x.reason : null,
      }))
      .filter((w) => w.gustoMemberId);
  } catch {
    return [];
  }
}

function coerceWhich(v: string): "current" | "previous" {
  return v === "previous" ? "previous" : "current";
}

function coerceSessionMode(v: string | null): "captured" | "generated" | null {
  return v === "captured" || v === "generated" ? v : null;
}

function toJob(r: JobRow): GustoPushJob {
  return {
    id: r.id,
    which: coerceWhich(r.which),
    periodStart: r.period_start,
    periodEnd: r.period_end,
    periodLabel: r.period_label,
    entries: parseEntries(r.entries),
    requester: r.requester,
    status: r.status as GustoPushJobStatus,
    phase: r.phase,
    draftPayrollId: r.draft_payroll_id,
    sessionMode: coerceSessionMode(r.session_mode),
    workers: parseWorkers(r.workers),
    screenshot: r.screenshot,
    error: r.error,
    aborted: r.aborted,
    canceledBy: r.canceled_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    claimedAt: r.claimed_at,
    finishedAt: r.finished_at,
  };
}

function rowById(id: string): JobRow | undefined {
  return getDb().prepare("SELECT * FROM gusto_push_jobs WHERE id = ?").get(id) as JobRow | undefined;
}

// ── Writes ──────────────────────────────────────────────────────────────────────

/** Record a new approved push job. `entries` come from the owner/admin-gated builder (buildPushEntries) — this
 *  store never computes hours. Returns the created job, or null when there are no entries or the write fails
 *  (never throws). New jobs start `queued`. */
export function createJob(input: {
  which: "current" | "previous";
  entries: GustoPushEntry[];
  period?: { start?: string | null; end?: string | null; label?: string | null };
  requester?: string | null;
}): GustoPushJob | null {
  const entries = Array.isArray(input.entries) ? input.entries.filter((e) => e && e.gustoMemberId) : [];
  if (!entries.length) return null;
  try {
    const db = getDb();
    const id = `GPJ-${randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO gusto_push_jobs (id, which, period_start, period_end, period_label, entries, requester, status, created_at, updated_at)
       VALUES (@id, @which, @periodStart, @periodEnd, @periodLabel, @entries, @requester, 'queued', @now, @now)`,
    ).run({
      id,
      which: coerceWhich(input.which),
      periodStart: input.period?.start?.trim() || null,
      periodEnd: input.period?.end?.trim() || null,
      periodLabel: input.period?.label?.trim() || null,
      entries: JSON.stringify(entries),
      requester: input.requester?.trim() || null,
      now,
    });
    const row = rowById(id);
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

/** Claim the oldest queued job for the runner: atomically flip exactly ONE queued row to claimed + stamp
 *  claimed_at. Single-assignment — the guarded UPDATE...WHERE status='queued' means two concurrent runners can
 *  never both claim the same job. Returns the claimed job, or null when nothing is queued. Never throws. */
export function claimNextQueued(): GustoPushJob | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const claim = db.transaction((): JobRow | null => {
      const next = db
        .prepare("SELECT id FROM gusto_push_jobs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1")
        .get() as { id: string } | undefined;
      if (!next) return null;
      const res = db
        .prepare("UPDATE gusto_push_jobs SET status='claimed', phase='Starting', claimed_at=@now, updated_at=@now WHERE id=@id AND status='queued'")
        .run({ id: next.id, now });
      if (res.changes !== 1) return null; // lost the race to another claimer
      return rowById(next.id) ?? null;
    });
    const row = claim();
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

/** The runner streams progress: a status within the active set, plus any of phase / latest screenshot ref /
 *  draft id / session mode / partial per-worker results. Only transitions a job that is still active (claimed |
 *  signin_required | pushing) — a terminal or canceled job is never reanimated. Returns the updated job or null. */
export function reportProgress(
  id: string,
  data: {
    status?: "signin_required" | "pushing";
    phase?: string | null;
    screenshot?: string | null;
    draftPayrollId?: string | null;
    sessionMode?: "captured" | "generated" | null;
    workers?: GustoPushWorkerResult[];
  },
): GustoPushJob | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const update = db.transaction((): JobRow | null => {
      const cur = rowById(id);
      if (!cur || !ACTIVE.includes(cur.status as GustoPushJobStatus)) return null;
      const nextStatus = data.status ?? (cur.status as GustoPushJobStatus);
      db.prepare(
        `UPDATE gusto_push_jobs SET
           status=@status,
           phase=COALESCE(@phase, phase),
           screenshot=COALESCE(@screenshot, screenshot),
           draft_payroll_id=COALESCE(@draftPayrollId, draft_payroll_id),
           session_mode=COALESCE(@sessionMode, session_mode),
           workers=COALESCE(@workers, workers),
           updated_at=@now
         WHERE id=@id`,
      ).run({
        id,
        status: nextStatus,
        phase: data.phase?.trim() || null,
        screenshot: data.screenshot?.trim() || null,
        draftPayrollId: data.draftPayrollId?.trim() || null,
        sessionMode: coerceSessionMode(data.sessionMode ?? null),
        workers: data.workers ? JSON.stringify(data.workers) : null,
        now,
      });
      return rowById(id) ?? null;
    });
    const row = update();
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

/** Mark an active job done with the final per-worker results. `aborted` records a CLEAN bail (e.g. the run
 *  wasn't a draft, or not_logged_in) — the job still ends `done` but carries why nothing was written. Only
 *  transitions an active job. Returns the updated job or null. */
export function completeJob(
  id: string,
  result: {
    workers?: GustoPushWorkerResult[];
    sessionMode?: "captured" | "generated" | null;
    draftPayrollId?: string | null;
    aborted?: string | null;
  },
): GustoPushJob | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const res = db
      .prepare(
        `UPDATE gusto_push_jobs SET
           status='done', phase='Finished',
           workers=COALESCE(@workers, workers),
           session_mode=COALESCE(@sessionMode, session_mode),
           draft_payroll_id=COALESCE(@draftPayrollId, draft_payroll_id),
           aborted=@aborted,
           updated_at=@now, finished_at=@now
         WHERE id=@id AND status IN ${ACTIVE_SQL}`,
      )
      .run({
        id,
        workers: result.workers ? JSON.stringify(result.workers) : null,
        sessionMode: coerceSessionMode(result.sessionMode ?? null),
        draftPayrollId: result.draftPayrollId?.trim() || null,
        aborted: result.aborted?.trim() || null,
        now,
      });
    if (res.changes !== 1) return null;
    const row = rowById(id);
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

/** Mark an active job failed with a short reason. Only transitions an active job. Returns the updated job or
 *  null. Never throws. */
export function failJob(id: string, error: string): GustoPushJob | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const res = db
      .prepare(
        `UPDATE gusto_push_jobs SET status='failed', phase='Failed', error=@error, updated_at=@now, finished_at=@now WHERE id=@id AND status IN ${ACTIVE_SQL}`,
      )
      .run({ id, error: (error || "unknown error").slice(0, 2000), now });
    if (res.changes !== 1) return null;
    const row = rowById(id);
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

/** A human cancels the push from the app. Allowed from queued OR any active state (the runner polls the job
 *  and stops when it sees `canceled`). Returns the updated job or null. Never throws. */
export function cancelJob(id: string, actor?: string | null): GustoPushJob | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const res = db
      .prepare(
        `UPDATE gusto_push_jobs SET status='canceled', phase='Canceled', canceled_by=@actor, updated_at=@now, finished_at=@now WHERE id=@id AND status IN ('queued','claimed','signin_required','pushing')`,
      )
      .run({ id, actor: actor?.trim() || null, now });
    if (res.changes !== 1) return null;
    const row = rowById(id);
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────────

export function getJob(id: string): GustoPushJob | null {
  try {
    const r = rowById(id);
    return r ? toJob(r) : null;
  } catch {
    return null;
  }
}

/** The single most-recent job (the pane follows this one), or null when none exists. Never throws. */
export function latestJob(): GustoPushJob | null {
  try {
    const r = getDb()
      .prepare("SELECT * FROM gusto_push_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get() as JobRow | undefined;
    return r ? toJob(r) : null;
  } catch {
    return null;
  }
}

/** True when a job is currently queued or active — the UI uses this to block a second concurrent push and to
 *  know whether to poll for live frames. Never throws. */
export function hasActiveJob(): boolean {
  try {
    const r = getDb()
      .prepare("SELECT 1 FROM gusto_push_jobs WHERE status IN ('queued','claimed','signin_required','pushing') LIMIT 1")
      .get();
    return !!r;
  } catch {
    return false;
  }
}

/** Recent jobs, newest first (default 20). Never throws (returns [] on any fault). */
export function listJobs(limit = 20): GustoPushJob[] {
  try {
    const db = getDb();
    const n = Math.min(Math.max(limit, 1), 200);
    return (db.prepare("SELECT * FROM gusto_push_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(n) as JobRow[]).map(toJob);
  } catch {
    return [];
  }
}
