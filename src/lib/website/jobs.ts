// Website Studio (Phase 1) — the website-change job queue store. A JOB is one plain-English request from
// the marketing team to change the company website. The app only RECORDS the ask here; the office-machine
// runner (tools/website-studio-runner) claims a pending job, runs the Claude Agent SDK against the SEPARATE
// website repo on a branch, renders the change on the LOCAL DevKinsta site, screenshots it, and posts those
// back as a PREVIEW. A human then approves (→ the runner pushes + opens a PR) or discards it. Nothing goes
// live until a human merges the PR. Mirrors the gs_outbox pattern (app queues, office machine drains) and
// the typed-store style of src/lib/ai/requests.ts.
//
// Governing law: this module is a pure state machine over `website_jobs` + thin DB access. It NEVER throws
// into its callers — every function returns a value or null and swallows DB faults. The state machine:
//   createJob        → pending
//   claimNextPending → pending  → running   (single assignment: at most one runner claims a given job)
//   setJobPreview    → running  → preview   (summary + changed files + page paths; screenshots uploaded
//                                            separately via addJobArtifact)
//   decideJob        → preview  → approved | discarded  (the human decision the runner waits on)
//   completeJob      → approved → done      (summary? + prUrl)
//   failJob          → running | approved → failed  (error)

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { coerceEnvironment, type WebsiteEnvironment } from "@/lib/website/config";

// ── Types ─────────────────────────────────────────────────────────────────────
export type WebsiteJobStatus =
  | "pending"
  | "running"
  | "preview"
  | "approved"
  | "done"
  | "discarded"
  | "failed";
export const WEBSITE_JOB_STATUSES: WebsiteJobStatus[] = [
  "pending",
  "running",
  "preview",
  "approved",
  "done",
  "discarded",
  "failed",
];

/** A saved screenshot reference. `label` is "<pageslug>-<viewport>" e.g. "home-desktop" / "home-mobile";
 *  the actual bytes live on the Fly volume and are served by the authed artifact route. */
export interface WebsiteJobArtifact {
  label: string;
  path: string;
}

export interface WebsiteJob {
  id: string;
  prompt: string;
  requester: string | null;
  status: WebsiteJobStatus;
  summary: string | null;
  changedFiles: string[];
  pagePaths: string[];
  artifacts: WebsiteJobArtifact[];
  prUrl: string | null;
  error: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  // Browse-and-edit upgrade: the EDIT CONTEXT captured from the embedded browser — the exact page URL the
  // marketer was viewing when they submitted, and which environment (prod/local) that page is on. These ride
  // along to the runner so the agent knows WHICH page to edit and in WHICH environment.
  contextUrl: string | null;
  environment: WebsiteEnvironment;
}

// ── Row shape + mapper ──────────────────────────────────────────────────────────
interface JobRow {
  id: string;
  prompt: string;
  requester: string | null;
  status: string;
  summary: string | null;
  changed_files: string | null;
  page_paths: string | null;
  artifacts: string | null;
  pr_url: string | null;
  error: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  context_url: string | null;
  environment: string | null;
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseArtifacts(json: string | null): WebsiteJobArtifact[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is { label: unknown; path: unknown } => !!x && typeof x === "object")
      .map((x) => ({ label: String((x as { label: unknown }).label ?? ""), path: String((x as { path: unknown }).path ?? "") }))
      .filter((a) => a.label && a.path);
  } catch {
    return [];
  }
}

function toJob(r: JobRow): WebsiteJob {
  return {
    id: r.id,
    prompt: r.prompt,
    requester: r.requester,
    status: r.status as WebsiteJobStatus,
    summary: r.summary,
    changedFiles: parseStringArray(r.changed_files),
    pagePaths: parseStringArray(r.page_paths),
    artifacts: parseArtifacts(r.artifacts),
    prUrl: r.pr_url,
    error: r.error,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    contextUrl: r.context_url,
    // A legacy row (queued before this upgrade) has null environment — treat it as production.
    environment: coerceEnvironment(r.environment),
  };
}

function rowById(id: string): JobRow | undefined {
  return getDb().prepare("SELECT * FROM website_jobs WHERE id = ?").get(id) as JobRow | undefined;
}

// ── Writes ──────────────────────────────────────────────────────────────────────

/** Queue a new website-change request. Returns the created job, or null if the prompt is empty or the write
 *  fails (never throws). New jobs start `pending`. `contextUrl` is the page the marketer was viewing in the
 *  embedded browser (the edit target) and `environment` is which site that page is on ('production' default,
 *  validated via coerceEnvironment). */
export function createJob(input: {
  prompt: string;
  requester?: string | null;
  contextUrl?: string | null;
  environment?: unknown;
}): WebsiteJob | null {
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) return null;
  try {
    const db = getDb();
    const id = `WJ-${randomUUID()}`;
    const now = new Date().toISOString();
    const contextUrl = (input.contextUrl ?? "").trim() || null;
    const environment = coerceEnvironment(input.environment);
    db.prepare(
      `INSERT INTO website_jobs (id, prompt, requester, status, context_url, environment, created_at, updated_at)
       VALUES (@id, @prompt, @requester, 'pending', @contextUrl, @environment, @now, @now)`,
    ).run({ id, prompt, requester: input.requester?.trim() || null, contextUrl, environment, now });
    const row = rowById(id);
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

/** Claim the oldest pending job for the runner: atomically flip exactly ONE pending row to running and stamp
 *  started_at. Single-assignment — the guarded UPDATE...WHERE status='pending' means two concurrent runners
 *  can never both claim the same job. Returns the claimed job, or null when nothing is pending. Never throws. */
export function claimNextPending(): WebsiteJob | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const claim = db.transaction((): JobRow | null => {
      const next = db
        .prepare("SELECT id FROM website_jobs WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1")
        .get() as { id: string } | undefined;
      if (!next) return null;
      const res = db
        .prepare("UPDATE website_jobs SET status='running', started_at=@now, updated_at=@now WHERE id=@id AND status='pending'")
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

/** The runner has finished editing + rendering + screenshotting: move running → preview, recording the
 *  agent's summary, the changed repo files, and the site page paths it changed. Only transitions a `running`
 *  job. Returns the updated job or null. */
export function setJobPreview(
  id: string,
  data: { summary?: string | null; changedFiles?: string[]; pagePaths?: string[] },
): WebsiteJob | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const res = db
      .prepare(
        "UPDATE website_jobs SET status='preview', summary=@summary, changed_files=@changedFiles, page_paths=@pagePaths, updated_at=@now WHERE id=@id AND status='running'",
      )
      .run({
        id,
        summary: data.summary?.trim() || null,
        changedFiles: JSON.stringify((data.changedFiles ?? []).filter((x) => typeof x === "string")),
        pagePaths: JSON.stringify((data.pagePaths ?? []).filter((x) => typeof x === "string")),
        now,
      });
    if (res.changes !== 1) return null;
    const row = rowById(id);
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

/** Append a screenshot artifact reference (idempotent per label — a re-upload replaces the same label).
 *  Allowed while the job is `running` or `preview` (the runner uploads screenshots just before flipping to
 *  preview). Returns the updated job or null. Never throws. */
export function addJobArtifact(id: string, artifact: WebsiteJobArtifact): WebsiteJob | null {
  if (!artifact.label || !artifact.path) return null;
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const add = db.transaction((): JobRow | null => {
      const cur = rowById(id);
      if (!cur || (cur.status !== "running" && cur.status !== "preview")) return null;
      const list = parseArtifacts(cur.artifacts).filter((a) => a.label !== artifact.label);
      list.push({ label: artifact.label, path: artifact.path });
      db.prepare("UPDATE website_jobs SET artifacts=@artifacts, updated_at=@now WHERE id=@id").run({
        id,
        artifacts: JSON.stringify(list),
        now,
      });
      return rowById(id) ?? null;
    });
    const row = add();
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

/** The human decision the runner waits on: approve (→ push + PR) or discard (→ delete branch + restore local
 *  site). Only transitions a `preview` job. Records who decided + when. Returns the updated job or null. */
export function decideJob(id: string, decision: "approve" | "discard", actor?: string | null): WebsiteJob | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const next = decision === "approve" ? "approved" : "discarded";
    const res = db
      .prepare("UPDATE website_jobs SET status=@next, decided_by=@actor, decided_at=@now, updated_at=@now WHERE id=@id AND status='preview'")
      .run({ id, next, actor: actor?.trim() || null, now });
    if (res.changes !== 1) return null;
    const row = rowById(id);
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

/** Mark an approved job done with the opened PR URL (and optionally a refreshed summary). Only transitions an
 *  `approved` job. Returns the updated job or null. */
export function completeJob(id: string, result: { summary?: string | null; prUrl?: string | null }): WebsiteJob | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const res = db
      .prepare(
        "UPDATE website_jobs SET status='done', summary=COALESCE(@summary, summary), pr_url=@prUrl, error=NULL, updated_at=@now WHERE id=@id AND status='approved'",
      )
      .run({ id, summary: result.summary?.trim() || null, prUrl: result.prUrl?.trim() || null, now });
    if (res.changes !== 1) return null;
    const row = rowById(id);
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

/** Mark a job failed with a short reason. Allowed from `running` (edit/render failed) or `approved`
 *  (push/PR failed). Returns the updated job or null. Never throws. */
export function failJob(id: string, error: string): WebsiteJob | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const res = db
      .prepare("UPDATE website_jobs SET status='failed', error=@error, updated_at=@now WHERE id=@id AND status IN ('running','approved')")
      .run({ id, error: (error || "unknown error").slice(0, 2000), now });
    if (res.changes !== 1) return null;
    const row = rowById(id);
    return row ? toJob(row) : null;
  } catch {
    return null;
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────────

export function getJob(id: string): WebsiteJob | null {
  try {
    const r = rowById(id);
    return r ? toJob(r) : null;
  } catch {
    return null;
  }
}

/** Recent jobs, newest first. Filter by `requester` to show a marketer only their own worklist. Never throws
 *  (returns [] on any fault). */
export function listJobs(opts: { requester?: string | null; limit?: number } = {}): WebsiteJob[] {
  try {
    const db = getDb();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    // rowid DESC is the tiebreaker: created_at is ISO-second/ms precision, so several jobs queued in the
    // same instant would otherwise order non-deterministically. rowid is monotonic with insertion.
    if (opts.requester != null) {
      return (db
        .prepare("SELECT * FROM website_jobs WHERE requester = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
        .all(opts.requester, limit) as JobRow[]).map(toJob);
    }
    return (db.prepare("SELECT * FROM website_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as JobRow[]).map(toJob);
  } catch {
    return [];
  }
}
