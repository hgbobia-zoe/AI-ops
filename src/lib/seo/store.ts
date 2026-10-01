// Persistence for the SEO Growth Engine — seo_opportunities, seo_status_history, seo_diagnostics.
// Mirrors the risk/scheduling store conventions: getDb() directly, a row interface + mapper, prefixed-UUID
// ids, ISO timestamps, JSON blobs as TEXT. FACTS ONLY — see types.ts. Server-only (better-sqlite3).

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import {
  type SeoOpportunity,
  type SeoStatus,
  type SeoStage,
  type SeoStatusEvent,
  type SeoDiagnostic,
  type SeoMetrics,
  type SeoSource,
  type SeoMetricsSource,
  type SeoIntent,
  type SeoAction,
  type SeoPriorityBreakdown,
  SEO_STATUSES,
  SEO_STAGES,
} from "./types";
import { canTransition } from "./stages";

// ── dedupe identity ────────────────────────────────────────────────────────────
/**
 * The stable identity of an opportunity: keyword + intent + geography, normalized. A re-pull of the same
 * keyword in the same intent/geo updates the row in place rather than creating a duplicate. (Full fuzzy
 * matching — stem/variant collapse — is Phase 2; this exact-normalized key is the Phase 1 floor.)
 */
export function dedupeKey(keyword: string, intent: string | null | undefined, geo: string | null | undefined): string {
  const k = keyword.trim().toLowerCase().replace(/\s+/g, " ");
  const i = (intent || "unknown").trim().toLowerCase();
  const g = (geo || "").trim().toLowerCase();
  return `${k}|${i}|${g}`;
}

// ── row <-> model ────────────────────────────────────────────────────────────────
interface OppRow {
  id: string;
  dedupe_key: string;
  keyword: string;
  related_keywords: string | null;
  intent: string | null;
  location: string | null;
  category: string | null;
  competitor_refs: string | null;
  metrics: string | null;
  metrics_source: string | null;
  source: string;
  research_at: string | null;
  matched_url: string | null;
  recommended_action: string | null;
  priority: number | null;
  priority_breakdown: string | null;
  explanation: string | null;
  owner: string | null;
  status: string;
  stage: string | null;
  is_seed: number;
  created_at: string;
  updated_at: string;
}

function parseArr(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
  } catch {
    return [];
  }
}

function parseMetrics(s: string | null): SeoMetrics | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as SeoMetrics) : null;
  } catch {
    return null;
  }
}

function parseBreakdown(s: string | null): SeoPriorityBreakdown | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && Array.isArray((v as SeoPriorityBreakdown).components) ? (v as SeoPriorityBreakdown) : null;
  } catch {
    return null;
  }
}

function toOpportunity(r: OppRow): SeoOpportunity {
  return {
    id: r.id,
    dedupeKey: r.dedupe_key,
    keyword: r.keyword,
    relatedKeywords: parseArr(r.related_keywords),
    intent: (r.intent as SeoIntent) ?? "unknown",
    location: r.location,
    category: r.category,
    competitorRefs: parseArr(r.competitor_refs),
    metrics: parseMetrics(r.metrics),
    metricsSource: (r.metrics_source as SeoMetricsSource) ?? "none",
    source: r.source as SeoSource,
    researchAt: r.research_at,
    matchedUrl: r.matched_url,
    recommendedAction: (r.recommended_action as SeoAction) ?? null,
    priority: r.priority,
    priorityBreakdown: parseBreakdown(r.priority_breakdown),
    explanation: r.explanation,
    owner: r.owner,
    status: r.status as SeoStatus,
    stage: (r.stage as SeoStage) ?? "DISCOVERED",
    isSeed: r.is_seed === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── opportunities ─────────────────────────────────────────────────────────────
export interface UpsertOpportunityInput {
  keyword: string;
  intent?: SeoIntent;
  location?: string | null;
  category?: string | null;
  relatedKeywords?: string[];
  competitorRefs?: string[];
  metrics?: SeoMetrics | null;
  metricsSource?: SeoMetricsSource;
  source?: SeoSource;
  /** ISO retrieval time of the metrics. */
  researchAt?: string | null;
  isSeed?: boolean;
}

/**
 * Idempotent create-or-update keyed by dedupe_key (keyword+intent+geo). A repeat refreshes the research
 * facts (related keywords, competitors, metrics, researchAt) but NEVER touches the human workflow state
 * (status, owner) or the derived decision (recommended_action, priority, explanation) once set — those are
 * owned by the review workflow, not the pull. Returns the opportunity id.
 */
export function upsertOpportunity(input: UpsertOpportunityInput): string {
  const db = getDb();
  const now = new Date().toISOString();
  const intent: SeoIntent = input.intent ?? "unknown";
  const key = dedupeKey(input.keyword, intent, input.location ?? null);
  const existing = db.prepare("SELECT id FROM seo_opportunities WHERE dedupe_key = ?").get(key) as { id: string } | undefined;

  const related = JSON.stringify(input.relatedKeywords ?? []);
  const competitors = JSON.stringify(input.competitorRefs ?? []);
  const metrics = input.metrics ? JSON.stringify(input.metrics) : null;
  const metricsSource: SeoMetricsSource = input.metricsSource ?? (input.metrics ? "ubersuggest" : "none");
  const source: SeoSource = input.source ?? "ubersuggest";

  if (existing) {
    db.prepare(
      `UPDATE seo_opportunities SET
         keyword = ?, related_keywords = ?, competitor_refs = ?, metrics = ?, metrics_source = ?,
         research_at = COALESCE(?, research_at), updated_at = ?
       WHERE id = ?`,
    ).run(input.keyword.trim(), related, competitors, metrics, metricsSource, input.researchAt ?? null, now, existing.id);
    return existing.id;
  }

  const id = `SEOP-${randomUUID()}`;
  db.prepare(
    `INSERT INTO seo_opportunities (
       id, dedupe_key, keyword, related_keywords, intent, location, category, competitor_refs,
       metrics, metrics_source, source, research_at, matched_url, recommended_action, priority,
       priority_breakdown, explanation, owner, status, stage, is_seed, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'new', 'DISCOVERED', ?, ?, ?)`,
  ).run(
    id,
    key,
    input.keyword.trim(),
    related,
    intent,
    input.location ?? null,
    input.category ?? null,
    competitors,
    metrics,
    metricsSource,
    source,
    input.researchAt ?? null,
    input.isSeed ? 1 : 0,
    now,
    now,
  );
  recordStatus(id, null, "new", null, "created");
  return id;
}

export function getOpportunity(id: string): SeoOpportunity | null {
  const r = getDb().prepare("SELECT * FROM seo_opportunities WHERE id = ?").get(id) as OppRow | undefined;
  return r ? toOpportunity(r) : null;
}

/** Look up an opportunity by its dedupe identity (keyword+intent+geo). Lets discovery distinguish new vs refreshed. */
export function findOpportunityByDedupe(keyword: string, intent: SeoIntent | null | undefined, location: string | null | undefined): SeoOpportunity | null {
  const key = dedupeKey(keyword, intent ?? "unknown", location ?? null);
  const r = getDb().prepare("SELECT * FROM seo_opportunities WHERE dedupe_key = ?").get(key) as OppRow | undefined;
  return r ? toOpportunity(r) : null;
}

export interface ListOpportunitiesFilter {
  status?: SeoStatus;
  limit?: number;
}

export function listOpportunities(filter: ListOpportunitiesFilter = {}): SeoOpportunity[] {
  const db = getDb();
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const rows = filter.status
    ? (db.prepare("SELECT * FROM seo_opportunities WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(filter.status, limit) as OppRow[])
    : (db.prepare("SELECT * FROM seo_opportunities ORDER BY updated_at DESC LIMIT ?").all(limit) as OppRow[]);
  return rows.map(toOpportunity);
}

/** Count of opportunities in each status (every status present, 0 when none). */
export function countsByStatus(): Record<SeoStatus, number> {
  const out = Object.fromEntries(SEO_STATUSES.map((s) => [s, 0])) as Record<SeoStatus, number>;
  const rows = getDb().prepare("SELECT status, COUNT(*) as n FROM seo_opportunities GROUP BY status").all() as { status: string; n: number }[];
  for (const r of rows) {
    if ((SEO_STATUSES as string[]).includes(r.status)) out[r.status as SeoStatus] = r.n;
  }
  return out;
}

/**
 * Move an opportunity to a new status, appending to the decision history. Returns false if the opportunity
 * does not exist. A no-op transition (same status) is still recorded if a note is supplied.
 */
export function setOpportunityStatus(id: string, to: SeoStatus, actor: string | null, note?: string | null): boolean {
  const db = getDb();
  const row = db.prepare("SELECT status FROM seo_opportunities WHERE id = ?").get(id) as { status: string } | undefined;
  if (!row) return false;
  const now = new Date().toISOString();
  db.prepare("UPDATE seo_opportunities SET status = ?, updated_at = ? WHERE id = ?").run(to, now, id);
  recordStatus(id, row.status as SeoStatus, to, actor, note ?? null);
  return true;
}

// Append one lifecycle transition. The from/to columns are generic TEXT, so this records BOTH the Phase-1
// `status` transitions and the Phase-2 `stage` transitions into the one decision-history table.
function recordStatus(opportunityId: string, from: string | null, to: string, actor: string | null, note: string | null): void {
  getDb()
    .prepare("INSERT INTO seo_status_history (id, opportunity_id, from_status, to_status, actor, note, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(`SEOH-${randomUUID()}`, opportunityId, from, to, actor, note, new Date().toISOString());
}

// ── Phase 2: Kanban stage + analysis ──────────────────────────────────────────────────────────────

/** Count of opportunities in each Kanban stage (every stage present, 0 when none). */
export function countsByStage(): Record<SeoStage, number> {
  const out = Object.fromEntries(SEO_STAGES.map((s) => [s, 0])) as Record<SeoStage, number>;
  const rows = getDb().prepare("SELECT COALESCE(stage, 'DISCOVERED') AS stage, COUNT(*) AS n FROM seo_opportunities GROUP BY COALESCE(stage, 'DISCOVERED')").all() as { stage: string; n: number }[];
  for (const r of rows) {
    if ((SEO_STAGES as string[]).includes(r.stage)) out[r.stage as SeoStage] = r.n;
  }
  return out;
}

export interface StageTransitionResult {
  ok: boolean;
  /** Why the transition was refused (invalid move or missing opportunity). */
  error?: string;
  from?: SeoStage;
  to?: SeoStage;
}

/**
 * Move an opportunity to a new Kanban stage, GUARDED by the transition map (stages.ts), and append the move
 * to the decision history. Returns {ok:false} with an error for an invalid transition (nothing is written) or
 * a missing opportunity. A same-stage move is a legal no-op (recorded only when a note is supplied). Pass
 * {force:true} to bypass the guard (admin override) — still recorded.
 */
export function setOpportunityStage(id: string, to: SeoStage, actor: string | null, note?: string | null, opts: { force?: boolean } = {}): StageTransitionResult {
  const db = getDb();
  const row = db.prepare("SELECT COALESCE(stage, 'DISCOVERED') AS stage FROM seo_opportunities WHERE id = ?").get(id) as { stage: string } | undefined;
  if (!row) return { ok: false, error: "not_found" };
  const from = row.stage as SeoStage;
  if (from === to && !note) return { ok: true, from, to }; // idempotent no-op
  if (!opts.force && !canTransition(from, to)) return { ok: false, error: `invalid transition ${from} → ${to}`, from, to };
  const now = new Date().toISOString();
  db.prepare("UPDATE seo_opportunities SET stage = ?, updated_at = ? WHERE id = ?").run(to, now, id);
  recordStatus(id, from, to, actor, note ?? null);
  return { ok: true, from, to };
}

export interface AnalysisWrite {
  matchedUrl: string | null;
  recommendedAction: SeoAction;
  priority: number;
  priorityBreakdown: SeoPriorityBreakdown;
  explanation: string;
}

/**
 * Persist the derived decision (matched URL + recommended action + priority + breakdown + explanation) from
 * the match/priority engines. Does NOT touch the human workflow state (status/stage/owner) — the caller moves
 * the stage separately. Returns false if the opportunity is missing.
 */
export function setAnalysis(id: string, a: AnalysisWrite): boolean {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM seo_opportunities WHERE id = ?").get(id);
  if (!exists) return false;
  db.prepare(
    `UPDATE seo_opportunities
       SET matched_url = ?, recommended_action = ?, priority = ?, priority_breakdown = ?, explanation = ?, updated_at = ?
     WHERE id = ?`,
  ).run(a.matchedUrl, a.recommendedAction, a.priority, JSON.stringify(a.priorityBreakdown), a.explanation, new Date().toISOString(), id);
  return true;
}

/** The full decision history (status + stage transitions) for an opportunity, newest first — generic strings. */
export function decisionHistory(id: string): { from: string | null; to: string; actor: string | null; note: string | null; ts: string }[] {
  const rows = getDb()
    .prepare("SELECT from_status, to_status, actor, note, ts FROM seo_status_history WHERE opportunity_id = ? ORDER BY ts DESC, rowid DESC")
    .all(id) as { from_status: string | null; to_status: string; actor: string | null; note: string | null; ts: string }[];
  return rows.map((r) => ({ from: r.from_status, to: r.to_status, actor: r.actor, note: r.note, ts: r.ts }));
}

export function statusHistory(opportunityId: string): SeoStatusEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM seo_status_history WHERE opportunity_id = ? ORDER BY ts DESC, rowid DESC")
    .all(opportunityId) as {
    id: string;
    opportunity_id: string;
    from_status: string | null;
    to_status: string;
    actor: string | null;
    note: string | null;
    ts: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    opportunityId: r.opportunity_id,
    fromStatus: (r.from_status as SeoStatus) ?? null,
    toStatus: r.to_status as SeoStatus,
    actor: r.actor,
    note: r.note,
    ts: r.ts,
  }));
}

// ── retrieval diagnostics ────────────────────────────────────────────────────────
export interface RecordRetrievalInput {
  operation: string;
  ok: boolean;
  tool?: string | null;
  statusCode?: number | null;
  rateLimited?: boolean;
  durationMs?: number | null;
  detail?: string | null;
}

/** Append one retrieval/probe diagnostic row. Never throws into the caller's hot path. */
export function recordRetrieval(input: RecordRetrievalInput): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO seo_diagnostics (id, ts, operation, tool, ok, status_code, rate_limited, duration_ms, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `SEOD-${randomUUID()}`,
        new Date().toISOString(),
        input.operation,
        input.tool ?? null,
        input.ok ? 1 : 0,
        input.statusCode ?? null,
        input.rateLimited ? 1 : 0,
        input.durationMs ?? null,
        input.detail ?? null,
      );
  } catch {
    /* diagnostics are best-effort; never break the caller */
  }
}

function toDiag(r: {
  id: string;
  ts: string;
  operation: string;
  tool: string | null;
  ok: number;
  status_code: number | null;
  rate_limited: number;
  duration_ms: number | null;
  detail: string | null;
}): SeoDiagnostic {
  return {
    id: r.id,
    ts: r.ts,
    operation: r.operation,
    tool: r.tool,
    ok: r.ok === 1,
    statusCode: r.status_code,
    rateLimited: r.rate_limited === 1,
    durationMs: r.duration_ms,
    detail: r.detail,
  };
}

// ORDER BY ts DESC, rowid DESC — the rowid tiebreak makes "newest" deterministic when two diagnostics
// share a millisecond timestamp (insertion order wins).
/** The most recent diagnostic of any kind (success or failure), or null. */
export function latestDiagnostic(): SeoDiagnostic | null {
  const r = getDb().prepare("SELECT * FROM seo_diagnostics ORDER BY ts DESC, rowid DESC LIMIT 1").get() as Parameters<typeof toDiag>[0] | undefined;
  return r ? toDiag(r) : null;
}

/** The most recent SUCCESSFUL diagnostic, or null — the honest "last successful retrieval". */
export function latestSuccess(): SeoDiagnostic | null {
  const r = getDb().prepare("SELECT * FROM seo_diagnostics WHERE ok = 1 ORDER BY ts DESC, rowid DESC LIMIT 1").get() as Parameters<typeof toDiag>[0] | undefined;
  return r ? toDiag(r) : null;
}

export function recentDiagnostics(limit = 20): SeoDiagnostic[] {
  const rows = getDb().prepare("SELECT * FROM seo_diagnostics ORDER BY ts DESC, rowid DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 200)) as Parameters<typeof toDiag>[0][];
  return rows.map(toDiag);
}
