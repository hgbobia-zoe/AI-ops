// SEO Growth Overview aggregation — the operational-status numbers behind the Overview page (spec §4).
// Deterministic + honest: counts come straight from the workflow table, health from the integration
// boundary. Phase 1 counts are almost all 0 (nothing pulled yet) — that is the correct, honest state.
// Server-only.

import { countsByStage, latestSuccess, recentDiagnostics } from "./store";
import { seoWatcherStatus, serpHealth, type SeoWatcherStatus } from "./watcher";
import type { SeoHealth, SeoStage, SeoDiagnostic } from "./types";

/**
 * The overview's top-level state (spec §4) — one honest classification the page leads with, so the operator
 * sees "what do I do now" before any numbers. Distinct states are never conflated: a disconnected source is
 * NOT "0 opportunities", and zero queued records is NOT zero SEO opportunity.
 *   setup_needed — the SERP source has never run; lead with the setup requirement + the real settings page.
 *   retrieving   — the source is reading live SERPs but no opportunities have materialised yet.
 *   no_records   — the source has read, but it has gone quiet and nothing is queued.
 *   error        — the last read failed/was blocked; the source needs attention.
 *   stale        — there are records but the source hasn't refreshed inside the staleness window.
 *   populated    — records present and the source is fresh; show the working pipeline.
 */
export type SeoOverviewState = "setup_needed" | "retrieving" | "no_records" | "error" | "stale" | "populated";

export interface SeoOverview {
  /** The honest top-level overview state the page leads with. */
  state: SeoOverviewState;
  /** Operational status items (spec §4). Each is a count of opportunities in that workflow state. */
  counts: {
    awaitingAnalysis: number; // new
    awaitingApproval: number; // awaiting_approval
    inProgress: number; // in_progress
    draftsAwaitingReview: number; // drafted
    recentlyPublished: number; // published
    deferredOrRejected: number; // deferred + rejected
    total: number;
  };
  /** Integration health (sync, no network) for the health card. */
  health: SeoHealth;
  /** The honest "last successful Ubersuggest retrieval" diagnostic, or null. */
  lastSuccess: SeoDiagnostic | null;
  /** Recent integration diagnostics (newest first) for the errors/stale display. */
  diagnostics: SeoDiagnostic[];
  /** Free-tier keyword-pull progress + limit-hit freshness (office-runner, path B). */
  watcher: SeoWatcherStatus;
}

/**
 * Classify the overview state from the (already honest) health + counts. PURE — no I/O, so it can be unit
 * tested across the full matrix and reused by the UI. Order matters: an unrun source is "setup_needed" even
 * though its counts are 0, and an errored source is flagged before its record counts.
 */
export function seoOverviewState(input: { health: Pick<SeoHealth, "status" | "stale">; counts: { total: number } }): SeoOverviewState {
  const { health, counts } = input;
  const hasRecords = counts.total > 0;
  if (health.status === "never" || health.status === "not_configured") return "setup_needed";
  if (health.status === "error") return "error";
  if (!hasRecords) return health.status === "stale" ? "no_records" : "retrieving";
  return health.status === "stale" || health.stale ? "stale" : "populated";
}

export function seoOverview(): SeoOverview {
  // Counts come from the Phase-2 Kanban stage (the canonical workflow state), mapped onto the Overview's
  // six honest buckets. (The Phase-1 `status` counts still exist via countsByStatus for back-compat.)
  const by: Record<SeoStage, number> = countsByStage();
  const total = (Object.values(by) as number[]).reduce((a, b) => a + b, 0);
  const health = serpHealth();
  return {
    state: seoOverviewState({ health, counts: { total } }),
    counts: {
      awaitingAnalysis: by.DISCOVERED,
      awaitingApproval: by.ANALYZING,
      inProgress: by.APPROVED + by.DRAFTING,
      draftsAwaitingReview: by.REVIEW + by.APPROVED_FOR_PUBLISHING,
      recentlyPublished: by.PUBLISHED + by.MONITORING,
      deferredOrRejected: by.DEFERRED + by.REJECTED + by.CONSOLIDATED + by.BLOCKED,
      total,
    },
    health,
    lastSuccess: latestSuccess(),
    diagnostics: recentDiagnostics(8),
    watcher: seoWatcherStatus(),
  };
}
