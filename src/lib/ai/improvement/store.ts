// Self-Improvement Controller — the run store. Typed persistence over improvement_runs /
// improvement_run_events, mirroring sessions.ts / requests.ts. The ONLY way a run changes state is
// `transitionRun`, which refuses an illegal move (the state machine is the rule) and records an append-only
// event. Nothing here executes code, git, or a deploy — it records what the controller decided.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { insertAudit } from "@/lib/db/repo";
import { canTransition, isTerminal } from "./machine";
import {
  type ImprovementRun, type RunEvent, type RunState, type RunScope, type ChangeBudget, type RunMetrics,
  type DeployInfo, type HealthResult, ZERO_METRICS,
} from "./types";

// ── JSON helpers ────────────────────────────────────────────────────────────────
function parse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

interface RunRow {
  id: string; request_id: string | null; blade: string; state: string;
  scope_json: string; budget_json: string; metrics_json: string;
  branch: string | null; commit_sha: string | null; pr_url: string | null; pr_number: number | null;
  deploy_json: string | null; health_json: string | null; plan: string | null; error: string | null;
  started_by: string | null; created_at: string; updated_at: string; ended_at: string | null;
}

function toRun(r: RunRow): ImprovementRun {
  return {
    id: r.id,
    requestId: r.request_id,
    blade: r.blade,
    state: r.state as RunState,
    scope: parse<RunScope>(r.scope_json, { blade: r.blade, summary: "", problem: "", allowedPaths: [], forbiddenPaths: [] }),
    budget: parse<ChangeBudget>(r.budget_json, {} as ChangeBudget),
    metrics: parse<RunMetrics>(r.metrics_json, ZERO_METRICS),
    branch: r.branch,
    commit: r.commit_sha,
    prUrl: r.pr_url,
    prNumber: r.pr_number,
    deploy: r.deploy_json ? parse<DeployInfo>(r.deploy_json, null as unknown as DeployInfo) : null,
    health: r.health_json ? parse<HealthResult>(r.health_json, null as unknown as HealthResult) : null,
    plan: r.plan,
    error: r.error,
    startedBy: r.started_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
  };
}

interface EventRow {
  id: string; run_id: string; ts: string; from_state: string | null; to_state: string;
  actor: string; note: string | null; payload: string | null;
}
function toEvent(r: EventRow): RunEvent {
  return {
    id: r.id, runId: r.run_id, ts: r.ts,
    from: (r.from_state as RunState | null) ?? null, to: r.to_state as RunState,
    actor: r.actor, note: r.note, payload: r.payload ? parse<Record<string, unknown>>(r.payload, {}) : null,
  };
}

// ── Create ──────────────────────────────────────────────────────────────────────
export interface NewRun {
  requestId?: string | null;
  scope: RunScope;
  budget: ChangeBudget;
  startedBy?: string | null;
}

/** Open a run in state `requested`, writing the initial lifecycle event + an audit row. */
export function createRun(input: NewRun): ImprovementRun {
  const db = getDb();
  const id = `IR-${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO improvement_runs (id, request_id, blade, state, scope_json, budget_json, metrics_json, created_at, updated_at)
     VALUES (@id, @requestId, @blade, 'requested', @scope, @budget, @metrics, @now, @now)`,
  ).run({
    id,
    requestId: input.requestId ?? null,
    blade: input.scope.blade,
    scope: JSON.stringify(input.scope),
    budget: JSON.stringify(input.budget),
    metrics: JSON.stringify(ZERO_METRICS),
    now,
  });
  recordEvent(id, null, "requested", input.startedBy ?? "controller", "Run opened", { requestId: input.requestId ?? null });
  if (input.startedBy) db.prepare("UPDATE improvement_runs SET started_by=@by WHERE id=@id").run({ by: input.startedBy, id });
  audit(id, "IMPROVEMENT_RUN_OPENED", input.startedBy ?? "controller", { blade: input.scope.blade, requestId: input.requestId ?? null });
  return getRun(id)!;
}

// ── Reads ───────────────────────────────────────────────────────────────────────
export function getRun(id: string): ImprovementRun | null {
  const r = getDb().prepare("SELECT * FROM improvement_runs WHERE id = ?").get(id) as RunRow | undefined;
  return r ? toRun(r) : null;
}

export function listRuns(opts: { state?: RunState; limit?: number } = {}): ImprovementRun[] {
  const limit = opts.limit ?? 100;
  const rows = opts.state
    ? (getDb().prepare("SELECT * FROM improvement_runs WHERE state = ? ORDER BY created_at DESC LIMIT ?").all(opts.state, limit) as RunRow[])
    : (getDb().prepare("SELECT * FROM improvement_runs ORDER BY created_at DESC LIMIT ?").all(limit) as RunRow[]);
  return rows.map(toRun);
}

/** Runs that are neither terminal (verified/rolled_back) — i.e. in flight or awaiting a human. */
export function listActiveRuns(limit = 100): ImprovementRun[] {
  return (
    getDb().prepare("SELECT * FROM improvement_runs WHERE state NOT IN ('verified','rolled_back') ORDER BY updated_at DESC LIMIT ?").all(limit) as RunRow[]
  ).map(toRun);
}

export function countRunsByState(): Record<string, number> {
  const rows = getDb().prepare("SELECT state, COUNT(*) AS n FROM improvement_runs GROUP BY state").all() as { state: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = r.n;
  return out;
}

export function listRunEvents(runId: string, limit = 500): RunEvent[] {
  return (getDb().prepare("SELECT * FROM improvement_run_events WHERE run_id = ? ORDER BY ts, rowid LIMIT ?").all(runId, limit) as EventRow[]).map(toEvent);
}

// ── The guarded transition — the one way state changes ─────────────────────────────
export interface TransitionResult {
  ok: boolean;
  run?: ImprovementRun;
  error?: string;
}

/** Move a run to `to`, but ONLY if the state machine allows it. Records an append-only event and (on a
 *  terminal state) stamps ended_at. An illegal transition is refused with an error — the rule, enforced in
 *  code, is the single source of truth for what may happen next. */
export function transitionRun(id: string, to: RunState, opts: { actor?: string; note?: string; payload?: Record<string, unknown>; error?: string } = {}): TransitionResult {
  const db = getDb();
  const cur = getRun(id);
  if (!cur) return { ok: false, error: "not_found" };
  if (!canTransition(cur.state, to)) return { ok: false, error: `illegal transition ${cur.state} -> ${to}` };
  const now = new Date().toISOString();
  const ended = isTerminal(to) ? now : null;
  db.prepare("UPDATE improvement_runs SET state=@to, error=@error, updated_at=@now, ended_at=COALESCE(@ended, ended_at) WHERE id=@id").run({
    to,
    error: opts.error ?? (to === "verified" ? null : cur.error),
    now,
    ended,
    id,
  });
  recordEvent(id, cur.state, to, opts.actor ?? "controller", opts.note ?? null, opts.payload ?? null);
  audit(id, "IMPROVEMENT_RUN_TRANSITION", opts.actor ?? "controller", { from: cur.state, to });
  return { ok: true, run: getRun(id)! };
}

// ── Artifact / metric setters (do not change state) ────────────────────────────────
export function updateRunMetrics(id: string, metrics: Partial<RunMetrics>): ImprovementRun | null {
  const cur = getRun(id);
  if (!cur) return null;
  const merged = { ...cur.metrics, ...metrics };
  touch(id, "metrics_json=@m", { m: JSON.stringify(merged) });
  return getRun(id);
}

export function setRunArtifacts(id: string, a: { branch?: string; commit?: string; prUrl?: string; prNumber?: number; plan?: string }): ImprovementRun | null {
  const cur = getRun(id);
  if (!cur) return null;
  touch(id, "branch=COALESCE(@branch,branch), commit_sha=COALESCE(@commit,commit_sha), pr_url=COALESCE(@prUrl,pr_url), pr_number=COALESCE(@prNumber,pr_number), plan=COALESCE(@plan,plan)", {
    branch: a.branch ?? null, commit: a.commit ?? null, prUrl: a.prUrl ?? null, prNumber: a.prNumber ?? null, plan: a.plan ?? null,
  });
  return getRun(id);
}

export function setRunDeploy(id: string, deploy: DeployInfo): ImprovementRun | null {
  if (!getRun(id)) return null;
  touch(id, "deploy_json=@d", { d: JSON.stringify(deploy) });
  return getRun(id);
}

export function setRunHealth(id: string, health: HealthResult): ImprovementRun | null {
  if (!getRun(id)) return null;
  touch(id, "health_json=@h", { h: JSON.stringify(health) });
  return getRun(id);
}

// ── internals ──────────────────────────────────────────────────────────────────
function touch(id: string, setClause: string, params: Record<string, unknown>): void {
  const now = new Date().toISOString();
  getDb().prepare(`UPDATE improvement_runs SET ${setClause}, updated_at=@now WHERE id=@id`).run({ ...params, id, now });
}

function recordEvent(runId: string, from: RunState | null, to: RunState, actor: string, note: string | null, payload: Record<string, unknown> | null): void {
  getDb().prepare(
    `INSERT INTO improvement_run_events (id, run_id, ts, from_state, to_state, actor, note, payload)
     VALUES (@id, @runId, @ts, @from, @to, @actor, @note, @payload)`,
  ).run({
    id: `IRE-${randomUUID()}`, runId, ts: new Date().toISOString(), from, to, actor, note, payload: payload ? JSON.stringify(payload) : null,
  });
}

function audit(runId: string, action: string, actor: string, detail: Record<string, unknown>): void {
  try { insertAudit({ actor, action, entity: "improvement_run", entityId: runId, after: detail }); } catch { /* best-effort */ }
}
