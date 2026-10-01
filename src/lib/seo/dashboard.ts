// SEO Growth Overview aggregation — the operational-status numbers behind the Overview page (spec §4).
// Deterministic + honest: counts come straight from the workflow table, health from the integration
// boundary. Phase 1 counts are almost all 0 (nothing pulled yet) — that is the correct, honest state.
// Server-only.

import { countsByStatus, latestSuccess, recentDiagnostics } from "./store";
import { getHealth } from "./ubersuggest";
import type { SeoHealth, SeoStatus, SeoDiagnostic } from "./types";

export interface SeoOverview {
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
}

export function seoOverview(): SeoOverview {
  const by: Record<SeoStatus, number> = countsByStatus();
  const total = (Object.values(by) as number[]).reduce((a, b) => a + b, 0);
  return {
    counts: {
      awaitingAnalysis: by.new,
      awaitingApproval: by.awaiting_approval,
      inProgress: by.in_progress,
      draftsAwaitingReview: by.drafted,
      recentlyPublished: by.published,
      deferredOrRejected: by.deferred + by.rejected,
      total,
    },
    health: getHealth(),
    lastSuccess: latestSuccess(),
    diagnostics: recentDiagnostics(8),
  };
}
