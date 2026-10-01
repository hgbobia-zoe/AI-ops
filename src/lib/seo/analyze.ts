// SEO Growth — analysis = match + priority, combined. PURE given the page inventory (no DB, no I/O), so it is
// fully unit-testable and reusable by both the discovery pipeline and the re-analyze path. "RULES CALCULATE."

import { matchOpportunity, type MatchInput } from "./match";
import { scorePriority } from "./priority";
import { ZOE_PAGES } from "./zoe-pages";
import type { SeoAction, SeoMetrics, SeoIntent, SeoMatchResult, SeoPriorityBreakdown, ZoePage } from "./types";

export interface AnalyzeInput {
  keyword: string;
  intent: SeoIntent;
  location: string | null;
  category: string | null;
  relatedKeywords?: string[];
  metrics?: SeoMetrics | null;
  competitorRefs?: string[];
}

export interface AnalysisResult {
  matchedUrl: string | null;
  matchedPath: string | null;
  recommendedAction: SeoAction;
  priority: number;
  priorityBreakdown: SeoPriorityBreakdown;
  explanation: string;
  match: SeoMatchResult;
}

/** Match an opportunity to the inventory and score its priority. Deterministic. */
export function analyzeOpportunity(opp: AnalyzeInput, pages: ZoePage[] = ZOE_PAGES): AnalysisResult {
  const matchInput: MatchInput = {
    keyword: opp.keyword,
    intent: opp.intent,
    location: opp.location,
    category: opp.category,
    relatedKeywords: opp.relatedKeywords,
  };
  const match = matchOpportunity(matchInput, pages);
  const breakdown = scorePriority({
    intent: opp.intent,
    category: opp.category,
    metrics: opp.metrics ?? null,
    match,
    competitorRefs: opp.competitorRefs,
  });
  const explanation = `${match.reason} ${breakdown.summary}`.trim();
  return {
    matchedUrl: match.matchedUrl,
    matchedPath: match.matchedPath,
    recommendedAction: match.action,
    priority: breakdown.score,
    priorityBreakdown: breakdown,
    explanation,
    match,
  };
}
