// Persistence + review workflow for SEO page drafts (seo_page_drafts). Mirrors the seo/store.ts conventions:
// getDb() directly, a row interface + mapper, prefixed-UUID ids, ISO timestamps, JSON blobs as TEXT.
// Server-only (better-sqlite3).
//
// THE REVIEW GATE lives here: DRAFT → IN_REVIEW → APPROVED | REJECTED. A human performs every transition; the
// engine never moves a draft to a "published" state and there is NO auto-publish — publishing is a separate,
// authorized step outside this engine. Each transition also advances the owning opportunity's Kanban stage
// (DRAFTING / REVIEW / APPROVED_FOR_PUBLISHING) through the guarded setOpportunityStage, and is logged to the
// shared seo_status_history decision trail. Producing a draft is IDEMPOTENT on (opportunity, slug): a repeat
// returns the existing draft rather than creating a duplicate, and never clobbers one already under review.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { setOpportunityStage } from "./store";
import type {
  PageDraft,
  PageDraftBodyBlock,
  PageDraftInternalLink,
  PageDraftSources,
  SeoAction,
  SeoDraftReviewState,
  SeoDraftSource,
  SeoQualityFinding,
} from "./types";
import type { ScaffoldedDraft } from "./draft";

interface DraftRow {
  id: string;
  opportunity_id: string;
  slug: string;
  action: string;
  template_path: string | null;
  title: string;
  meta_description: string | null;
  h1: string;
  canonical_url: string | null;
  outline_json: string;
  body_json: string;
  schema_json: string | null;
  internal_links_json: string | null;
  sources_json: string | null;
  flags_json: string | null;
  draft_source: string;
  review_state: string;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function toDraft(r: DraftRow): PageDraft {
  return {
    id: r.id,
    opportunityId: r.opportunity_id,
    slug: r.slug,
    action: r.action as SeoAction,
    templatePath: r.template_path,
    title: r.title,
    metaDescription: r.meta_description ?? "",
    h1: r.h1,
    canonicalUrl: r.canonical_url ?? "",
    outline: parseJson<string[]>(r.outline_json, []),
    body: parseJson<PageDraftBodyBlock[]>(r.body_json, []),
    schema: parseJson<Record<string, unknown> | null>(r.schema_json, null),
    internalLinks: parseJson<PageDraftInternalLink[]>(r.internal_links_json, []),
    sources: parseJson<PageDraftSources>(r.sources_json, {
      keyword: "",
      intent: "unknown",
      location: null,
      category: null,
      relatedKeywords: [],
      competitorRefs: [],
      metrics: null,
      metricsSource: "none",
      researchAt: null,
      templatePath: null,
      researchNote: "",
    }),
    flags: parseJson<SeoQualityFinding[]>(r.flags_json, []),
    draftSource: r.draft_source as SeoDraftSource,
    reviewState: r.review_state as SeoDraftReviewState,
    reviewNote: r.review_note,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Append one draft-lifecycle transition to the shared decision history (keyed by the owning opportunity, so
// a draft's review trail sits alongside its opportunity's stage history).
function recordDraftAudit(opportunityId: string, from: string | null, to: string, actor: string | null, note: string | null): void {
  getDb()
    .prepare("INSERT INTO seo_status_history (id, opportunity_id, from_status, to_status, actor, note, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(`SEOH-${randomUUID()}`, opportunityId, from, to, actor, note, new Date().toISOString());
}

export function getDraft(id: string): PageDraft | null {
  const r = getDb().prepare("SELECT * FROM seo_page_drafts WHERE id = ?").get(id) as DraftRow | undefined;
  return r ? toDraft(r) : null;
}

/** The latest draft for an opportunity (newest first), or null. */
export function getDraftByOpportunity(opportunityId: string): PageDraft | null {
  const r = getDb().prepare("SELECT * FROM seo_page_drafts WHERE opportunity_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(opportunityId) as DraftRow | undefined;
  return r ? toDraft(r) : null;
}

export interface ListDraftsFilter {
  reviewState?: SeoDraftReviewState;
  limit?: number;
}

export function listDrafts(filter: ListDraftsFilter = {}): PageDraft[] {
  const db = getDb();
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const rows = filter.reviewState
    ? (db.prepare("SELECT * FROM seo_page_drafts WHERE review_state = ? ORDER BY updated_at DESC LIMIT ?").all(filter.reviewState, limit) as DraftRow[])
    : (db.prepare("SELECT * FROM seo_page_drafts ORDER BY updated_at DESC LIMIT ?").all(limit) as DraftRow[]);
  return rows.map(toDraft);
}

export interface CreateDraftResult {
  draft: PageDraft;
  /** true when a NEW row was inserted; false when an existing draft was returned (idempotent) or refreshed. */
  created: boolean;
  /** present when a repeat was refused a content overwrite because the draft is past DRAFT state. */
  note?: string;
}

export interface CreateDraftInput {
  opportunityId: string;
  scaffold: ScaffoldedDraft;
  /** Quality findings snapshot at draft time. */
  flags: SeoQualityFinding[];
  draftSource: SeoDraftSource;
  createdBy: string | null;
  /** Regenerate the content of an existing DRAFT-state draft in place (never an IN_REVIEW/APPROVED one). */
  force?: boolean;
}

/**
 * Create-or-get a page draft, IDEMPOTENT on (opportunity, slug). A first call inserts; a repeat returns the
 * existing draft unchanged (created:false). With {force:true} and the existing draft still in DRAFT state, the
 * content is refreshed in place; a draft already IN_REVIEW/APPROVED/REJECTED is never silently overwritten.
 */
export function createOrGetDraft(input: CreateDraftInput): CreateDraftResult {
  const db = getDb();
  const now = new Date().toISOString();
  const s = input.scaffold;
  const existing = db.prepare("SELECT * FROM seo_page_drafts WHERE opportunity_id = ? AND slug = ?").get(input.opportunityId, s.slug) as DraftRow | undefined;

  if (existing) {
    if (!input.force) return { draft: toDraft(existing), created: false };
    if (existing.review_state !== "DRAFT") {
      return { draft: toDraft(existing), created: false, note: `Draft is ${existing.review_state}; not regenerated. Reject or reopen it first to regenerate.` };
    }
    db.prepare(
      `UPDATE seo_page_drafts SET
         action = ?, template_path = ?, title = ?, meta_description = ?, h1 = ?, canonical_url = ?,
         outline_json = ?, body_json = ?, schema_json = ?, internal_links_json = ?, sources_json = ?,
         flags_json = ?, draft_source = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      s.action,
      s.templatePath,
      s.title,
      s.metaDescription,
      s.h1,
      s.canonicalUrl,
      JSON.stringify(s.outline),
      JSON.stringify(s.body),
      JSON.stringify(s.schema),
      JSON.stringify(s.internalLinks),
      JSON.stringify(s.sources),
      JSON.stringify(input.flags),
      input.draftSource,
      now,
      existing.id,
    );
    recordDraftAudit(input.opportunityId, "DRAFT", "DRAFT", input.createdBy, "draft regenerated");
    return { draft: getDraft(existing.id)!, created: false };
  }

  const id = `SEOPD-${randomUUID()}`;
  db.prepare(
    `INSERT INTO seo_page_drafts (
       id, opportunity_id, slug, action, template_path, title, meta_description, h1, canonical_url,
       outline_json, body_json, schema_json, internal_links_json, sources_json, flags_json, draft_source,
       review_state, review_note, reviewed_by, reviewed_at, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.opportunityId,
    s.slug,
    s.action,
    s.templatePath,
    s.title,
    s.metaDescription,
    s.h1,
    s.canonicalUrl,
    JSON.stringify(s.outline),
    JSON.stringify(s.body),
    JSON.stringify(s.schema),
    JSON.stringify(s.internalLinks),
    JSON.stringify(s.sources),
    JSON.stringify(input.flags),
    input.draftSource,
    input.createdBy,
    now,
    now,
  );
  recordDraftAudit(input.opportunityId, null, "DRAFT", input.createdBy, "draft created");
  return { draft: getDraft(id)!, created: true };
}

export interface ReviewResult {
  ok: boolean;
  error?: string;
  draft?: PageDraft;
}

function setState(id: string, to: SeoDraftReviewState, actor: string | null, note: string | null): void {
  const now = new Date().toISOString();
  const reviewed = to === "APPROVED" || to === "REJECTED";
  getDb()
    .prepare(
      `UPDATE seo_page_drafts SET review_state = ?, review_note = COALESCE(?, review_note),
         reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(to, note, reviewed ? actor : null, reviewed ? now : null, now, id);
}

/** Submit a DRAFT for editorial review (DRAFT → IN_REVIEW). Advances the opportunity to REVIEW. */
export function submitForReview(id: string, actor: string | null, note?: string | null): ReviewResult {
  const d = getDraft(id);
  if (!d) return { ok: false, error: "not_found" };
  if (d.reviewState !== "DRAFT") return { ok: false, error: `cannot submit a ${d.reviewState} draft` };
  setState(id, "IN_REVIEW", actor, note ?? null);
  recordDraftAudit(d.opportunityId, "DRAFT", "IN_REVIEW", actor, note ?? "draft submitted for review");
  // Advance the opportunity's Kanban stage (guarded; forced so a draft submit always reflects on the board).
  setOpportunityStage(d.opportunityId, "REVIEW", actor, "draft submitted for review", { force: true });
  return { ok: true, draft: getDraft(id)! };
}

/**
 * APPROVE a draft under review — the human go/no-go (gate #3). IN_REVIEW → APPROVED, and the opportunity moves
 * to APPROVED_FOR_PUBLISHING. This is the FURTHEST the engine takes a page on its own: it never publishes.
 */
export function approveDraft(id: string, actor: string | null, note?: string | null): ReviewResult {
  const d = getDraft(id);
  if (!d) return { ok: false, error: "not_found" };
  if (d.reviewState !== "IN_REVIEW") return { ok: false, error: `cannot approve a ${d.reviewState} draft` };
  setState(id, "APPROVED", actor, note ?? null);
  recordDraftAudit(d.opportunityId, "IN_REVIEW", "APPROVED", actor, note ?? "draft approved (cleared to publish — publishing is a separate authorized step)");
  setOpportunityStage(d.opportunityId, "APPROVED_FOR_PUBLISHING", actor, "draft approved", { force: true });
  return { ok: true, draft: getDraft(id)! };
}

/** REJECT a draft (DRAFT or IN_REVIEW → REJECTED). Sends the opportunity back to DRAFTING for a revision. */
export function rejectDraft(id: string, actor: string | null, note?: string | null): ReviewResult {
  const d = getDraft(id);
  if (!d) return { ok: false, error: "not_found" };
  if (d.reviewState === "APPROVED") return { ok: false, error: "cannot reject an approved draft" };
  const from = d.reviewState;
  setState(id, "REJECTED", actor, note ?? null);
  recordDraftAudit(d.opportunityId, from, "REJECTED", actor, note ?? "draft rejected");
  setOpportunityStage(d.opportunityId, "DRAFTING", actor, "draft rejected — revise", { force: true });
  return { ok: true, draft: getDraft(id)! };
}

/** Reopen a REJECTED draft back to DRAFT so it can be regenerated/revised. */
export function reopenDraft(id: string, actor: string | null): ReviewResult {
  const d = getDraft(id);
  if (!d) return { ok: false, error: "not_found" };
  if (d.reviewState !== "REJECTED") return { ok: false, error: `cannot reopen a ${d.reviewState} draft` };
  setState(id, "DRAFT", actor, null);
  recordDraftAudit(d.opportunityId, "REJECTED", "DRAFT", actor, "draft reopened");
  return { ok: true, draft: getDraft(id)! };
}
