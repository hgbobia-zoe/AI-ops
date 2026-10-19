// SEO Growth — the research-to-page PRODUCTION entry point. Ties the pieces together: it loads an APPROVED
// opportunity, scaffolds a structured landing-page draft (deterministic, facts + [NEEDS REVIEW] markers),
// runs the deterministic quality checks, and persists the draft idempotently — then advances the opportunity
// onto the DRAFTING stage. Server-only (DB + store).
//
// GATES (content production is kept separate from publication): a draft is only produced for an opportunity
// that a human has already APPROVED (stage APPROVED or further along the content flow) and whose recommended
// action is not SKIP. The furthest this takes a page on its own is a DRAFT awaiting human review — it never
// approves or publishes anything.

import { getOpportunity, setOpportunityStage, listOpportunities } from "./store";
import { scaffoldPageDraft, type ScaffoldInput, type ScaffoldedDraft } from "./draft";
import { runQualityChecks } from "./quality";
import { createOrGetDraft, getDraftByOpportunity, listDrafts } from "./draftStore";
import { ZOE_PAGES } from "./zoe-pages";
import type { PageDraft, SeoAction, SeoDraftReviewState, SeoQualityReport, SeoStage, ZoePage } from "./types";

/** Opportunity stages from which a draft may be produced (content flow only — never from un-approved stages). */
const PRODUCIBLE: SeoStage[] = ["APPROVED", "DRAFTING", "REVIEW", "APPROVED_FOR_PUBLISHING"];

export interface ProduceResult {
  ok: boolean;
  error?: string;
  draft?: PageDraft;
  quality?: SeoQualityReport;
  created?: boolean;
  note?: string;
}

export interface ProduceOptions {
  /** Regenerate an existing DRAFT-state draft in place (never an in-review/approved one). */
  force?: boolean;
  /** Override the page inventory (tests). */
  pages?: ZoePage[];
  actor?: string | null;
}

/** Build the scaffolder input from a stored opportunity. */
export function scaffoldInputFromOpportunity(oppId: string): ScaffoldInput | null {
  const o = getOpportunity(oppId);
  if (!o) return null;
  return {
    keyword: o.keyword,
    intent: o.intent,
    location: o.location,
    category: o.category,
    relatedKeywords: o.relatedKeywords,
    competitorRefs: o.competitorRefs,
    metrics: o.metrics,
    metricsSource: o.metricsSource,
    researchAt: o.researchAt,
    action: o.recommendedAction ?? "CREATE",
    matchedUrl: o.matchedUrl,
  };
}

/** Build a transient PageDraft (review metadata zeroed) so the pure quality checker can score a fresh scaffold. */
function scaffoldToTransient(oppId: string, s: ScaffoldedDraft): PageDraft {
  const now = new Date().toISOString();
  return {
    id: "transient",
    opportunityId: oppId,
    slug: s.slug,
    action: s.action,
    templatePath: s.templatePath,
    title: s.title,
    metaDescription: s.metaDescription,
    h1: s.h1,
    canonicalUrl: s.canonicalUrl,
    outline: s.outline,
    body: s.body,
    schema: s.schema,
    internalLinks: s.internalLinks,
    sources: s.sources,
    flags: [],
    draftSource: "deterministic",
    reviewState: "DRAFT",
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Produce (or fetch) the page draft for an opportunity. Deterministic + idempotent on (opportunity, slug).
 * Returns the draft + a freshly computed quality report. Enforces the approval gate.
 */
export function produceDraft(oppId: string, opts: ProduceOptions = {}): ProduceResult {
  const o = getOpportunity(oppId);
  if (!o) return { ok: false, error: "not_found" };
  if ((o.recommendedAction ?? "") === "SKIP" || o.recommendedAction == null) {
    return { ok: false, error: "not_producible", note: `Opportunity recommended action is ${o.recommendedAction ?? "none"}; only CREATE / IMPROVE / CONSOLIDATE opportunities are drafted.` };
  }
  if (!PRODUCIBLE.includes(o.stage)) {
    return { ok: false, error: "not_approved", note: `Opportunity is in stage ${o.stage}; approve it first (it must reach APPROVED before a draft is produced). Content production is gated behind the opportunity-approval decision.` };
  }

  const pages = opts.pages ?? ZOE_PAGES;
  const input = scaffoldInputFromOpportunity(oppId)!;
  const scaffold = scaffoldPageDraft(input, pages);
  const transient = scaffoldToTransient(oppId, scaffold);
  const quality = runQualityChecks(transient, pages);

  const res = createOrGetDraft({
    opportunityId: oppId,
    scaffold,
    flags: quality.findings,
    draftSource: "deterministic",
    createdBy: opts.actor ?? null,
    force: opts.force,
  });

  // Advance the opportunity onto the DRAFTING stage on first production (guarded; legal from APPROVED).
  if (o.stage === "APPROVED") setOpportunityStage(oppId, "DRAFTING", opts.actor ?? "system (produce)", "draft produced");

  // Re-run quality against the PERSISTED draft so the returned report matches what is stored.
  const finalQuality = runQualityChecks(res.draft, pages);
  return { ok: true, draft: res.draft, quality: finalQuality, created: res.created, note: res.note };
}

/** Fetch the current draft for an opportunity with a freshly computed quality report (or null). */
export function draftWithQuality(oppId: string, pages: ZoePage[] = ZOE_PAGES): { draft: PageDraft; quality: SeoQualityReport } | null {
  const draft = getDraftByOpportunity(oppId);
  if (!draft) return null;
  return { draft, quality: runQualityChecks(draft, pages) };
}

// ── surfaces (Content Studio + Review Queue) ─────────────────────────────────────────────────────────

/** A compact draft summary for a worklist row (no full body — the panel fetches that on open). */
export interface DraftSummary {
  id: string;
  slug: string;
  reviewState: SeoDraftReviewState;
  errors: number;
  warnings: number;
  unsupportedClaims: number;
}

/** One Content Studio / Review Queue row: the opportunity + its draft summary (if any). */
export interface StudioRow {
  id: string;
  keyword: string;
  category: string | null;
  location: string | null;
  stage: SeoStage;
  action: SeoAction | null;
  priority: number | null;
  draft: DraftSummary | null;
}

function summarize(draft: PageDraft | null, pages: ZoePage[]): DraftSummary | null {
  if (!draft) return null;
  const q = runQualityChecks(draft, pages);
  return { id: draft.id, slug: draft.slug, reviewState: draft.reviewState, errors: q.errors, warnings: q.warnings, unsupportedClaims: q.unsupportedClaims };
}

const PRODUCIBLE_SET = new Set<SeoStage>(PRODUCIBLE);

/** Opportunities a human has approved for content (producible stages), each with its draft summary. */
export function contentStudioRows(pages: ZoePage[] = ZOE_PAGES): StudioRow[] {
  return listOpportunities({ limit: 1000 })
    .filter((o) => PRODUCIBLE_SET.has(o.stage) && o.recommendedAction != null && o.recommendedAction !== "SKIP")
    .map((o) => ({
      id: o.id,
      keyword: o.keyword,
      category: o.category,
      location: o.location,
      stage: o.stage,
      action: o.recommendedAction,
      priority: o.priority,
      draft: summarize(getDraftByOpportunity(o.id), pages),
    }));
}

/** Drafts currently awaiting editorial review (the Review Queue), newest first. */
export function reviewQueueRows(pages: ZoePage[] = ZOE_PAGES): StudioRow[] {
  return listDrafts({ reviewState: "IN_REVIEW", limit: 500 }).map((draft) => {
    const o = getOpportunity(draft.opportunityId);
    return {
      id: draft.opportunityId,
      keyword: o?.keyword ?? draft.title,
      category: o?.category ?? null,
      location: o?.location ?? null,
      stage: o?.stage ?? "REVIEW",
      action: o?.recommendedAction ?? draft.action,
      priority: o?.priority ?? null,
      draft: summarize(draft, pages),
    };
  });
}
