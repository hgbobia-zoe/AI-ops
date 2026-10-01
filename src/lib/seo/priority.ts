// SEO Growth — explainable priority score. PURE (no DB, no I/O). Blends commercial intent, demand, plausible
// ranking opportunity, relevance, competitor evidence, existing coverage, effort and overlap risk into one
// 0–100 score, and EXPOSES every sub-score with the evidence it rests on.
//
// HONESTY LAW: it NEVER invents rankings, traffic or revenue. When a third-party metric (volume, difficulty)
// is absent it uses an explicitly-labelled neutral placeholder and says so in the evidence — a missing metric
// is UNKNOWN, never 0. The score is a prioritization heuristic over what we know, not a traffic/revenue claim.

import type { SeoAction, SeoIntent, SeoMatchResult, SeoMetrics, SeoPriorityBreakdown, SeoScoreComponent } from "./types";

export interface PriorityInput {
  intent: SeoIntent;
  category: string | null;
  metrics: SeoMetrics | null;
  match: SeoMatchResult;
  competitorRefs?: string[];
}

const NEUTRAL = 50;

/** Monthly volume → 0–100 on a log curve (≈1k ⇒ ~60, ≈10k ⇒ ~85). */
function volumeScore(v: number): number {
  if (v <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((Math.log10(v) / 4) * 100)));
}

function intentScore(intent: SeoIntent): number {
  switch (intent) {
    case "commercial": return 100;
    case "transactional": return 92;
    case "navigational": return 45;
    case "informational": return 35;
    default: return NEUTRAL;
  }
}

// Existing-coverage leverage + effort + overlap risk all key off the matcher's action.
function coverageScore(action: SeoAction): number {
  switch (action) {
    case "IMPROVE": return 85; // we already have a page — high leverage
    case "CONSOLIDATE": return 60;
    case "CREATE": return 55;
    case "SKIP": return 5;
  }
}
function effortScore(action: SeoAction): number {
  // Higher = less effort (so it lifts priority).
  switch (action) {
    case "IMPROVE": return 85;
    case "CONSOLIDATE": return 45;
    case "CREATE": return 35;
    case "SKIP": return 50;
  }
}

export function scorePriority(input: PriorityInput): SeoPriorityBreakdown {
  const m = input.metrics;
  const components: SeoScoreComponent[] = [];

  // 1. Commercial intent.
  components.push({
    key: "intent",
    label: "Commercial intent",
    score: intentScore(input.intent),
    weight: 0.24,
    evidence: `Intent is "${input.intent}".`,
    unknown: input.intent === "unknown",
  });

  // 2. Demand (search volume).
  if (m?.volume != null) {
    components.push({ key: "demand", label: "Search demand", score: volumeScore(m.volume), weight: 0.2, evidence: `Ubersuggest volume ≈ ${m.volume.toLocaleString("en-US")}/mo.`, unknown: false });
  } else {
    components.push({ key: "demand", label: "Search demand", score: NEUTRAL, weight: 0.2, evidence: "Volume unknown — no Ubersuggest data yet (neutral placeholder, not zero).", unknown: true });
  }

  // 3. Ranking opportunity (inverse difficulty).
  if (m?.difficulty != null) {
    components.push({ key: "ranking", label: "Ranking opportunity", score: Math.max(0, Math.min(100, 100 - m.difficulty)), weight: 0.16, evidence: `SEO difficulty ${m.difficulty}/100 (lower is easier to rank).`, unknown: false });
  } else {
    components.push({ key: "ranking", label: "Ranking opportunity", score: NEUTRAL, weight: 0.16, evidence: "Difficulty unknown — no Ubersuggest data yet (neutral placeholder).", unknown: true });
  }

  // 4. Relevance (matcher confidence + category presence).
  const relevance = Math.round(Math.min(100, input.match.confidence * 80 + (input.category ? 20 : 0)));
  components.push({ key: "relevance", label: "Relevance to Zoe", score: relevance, weight: 0.14, evidence: input.category ? `In Zoe category "${input.category}"; match confidence ${(input.match.confidence * 100).toFixed(0)}%.` : `No Zoe category; match confidence ${(input.match.confidence * 100).toFixed(0)}%.`, unknown: false });

  // 5. Competitor evidence.
  const comp = input.competitorRefs ?? [];
  components.push({ key: "competitor", label: "Competitor evidence", score: comp.length ? Math.min(80, 40 + comp.length * 10) : NEUTRAL, weight: 0.08, evidence: comp.length ? `${comp.length} competitor domain(s) rank for this: ${comp.slice(0, 3).join(", ")}.` : "No competitor ranking data (neutral placeholder).", unknown: comp.length === 0 });

  // 6. Existing coverage leverage.
  components.push({ key: "coverage", label: "Existing coverage", score: coverageScore(input.match.action), weight: 0.1, evidence: `Recommended action is ${input.match.action}.`, unknown: false });

  // 7. Effort (inverse).
  components.push({ key: "effort", label: "Effort (inverse)", score: effortScore(input.match.action), weight: 0.04, evidence: `${input.match.action} effort profile.`, unknown: false });

  // 8. Overlap risk (inverse) — more strong existing candidates ⇒ higher cannibalization risk ⇒ lower.
  const strong = input.match.candidates.filter((c) => c.score >= 0.5).length;
  const overlap = Math.max(0, 100 - strong * 25);
  components.push({ key: "overlap", label: "Overlap risk (inverse)", score: overlap, weight: 0.04, evidence: strong > 1 ? `${strong} existing pages already compete — consolidation risk.` : "Low overlap with existing pages.", unknown: false });

  const weightSum = components.reduce((a, c) => a + c.weight, 0);
  let score = Math.round(components.reduce((a, c) => a + c.score * c.weight, 0) / weightSum);

  // A SKIP is never a priority, whatever the metrics say.
  if (input.match.action === "SKIP") score = Math.min(score, 15);
  score = Math.max(0, Math.min(100, score));

  const unknowns = components.filter((c) => c.unknown).length;
  const summary =
    input.match.action === "SKIP"
      ? "Low priority — recommended action is SKIP."
      : `Priority ${score}/100 (${input.match.action}). ${unknowns > 0 ? `${unknowns} input(s) unknown without live Ubersuggest data — scored on a neutral placeholder.` : "All inputs available."}`;

  return { score, components, summary };
}
