// SEO Growth — competitive GAP findings. "RULES CALCULATE, AI INTERPRETS."
//
// buildFinding() is PURE and DETERMINISTIC: it reads an opportunity's OBSERVED SERP (who ranks, Zoe's position)
// and states the gap + the recommended action in plain words. enrichFinding() is an OPTIONAL pass that asks the
// shared LLM to phrase a short, human recommendation — it may only INTERPRET the deterministic facts, never
// invent a ranking, a volume or a competitor. It degrades gracefully: no LLM configured (or any error) →
// the deterministic recommendation stands, honestly labelled. Nothing here fabricates data.

import { chat, llmConfigured } from "@/lib/llm";
import { humanize } from "@/lib/salesos/outreach";
import { listOpportunities } from "./store";
import type { SeoAction, SeoOpportunity } from "./types";

/** gap = Zoe absent while rivals rank; improve = Zoe on page 1 but not top-3; defend = Zoe top-3; none = no
 *  SERP read yet, or no competitive signal. */
export type SeoFindingKind = "gap" | "improve" | "defend" | "none";

export interface SeoFinding {
  opportunityId: string;
  keyword: string;
  location: string | null;
  category: string | null;
  kind: SeoFindingKind;
  /** The matcher's recommended action (CREATE/IMPROVE/CONSOLIDATE/SKIP), or null when not yet analyzed. */
  action: SeoAction | null;
  priority: number | null;
  /** Zoe's observed organic position, or null when absent from page 1 / no SERP read. */
  zoeRank: number | null;
  /** Competitor domains ranking ABOVE Zoe (or all competitors when Zoe is absent), best-first. */
  competitorsAhead: string[];
  headline: string;
  detail: string;
  /** The actionable recommendation. Deterministic by default; LLM-phrased only after enrichFinding() succeeds. */
  recommendation: string;
  recommendationSource: "deterministic" | "llm";
}

/** Build the DETERMINISTIC finding for one opportunity from its SERP read. Pure — no I/O. */
export function buildFinding(opp: SeoOpportunity): SeoFinding {
  const serp = opp.serp;
  const base = {
    opportunityId: opp.id,
    keyword: opp.keyword,
    location: opp.location,
    category: opp.category,
    action: opp.recommendedAction,
    priority: opp.priority,
    recommendationSource: "deterministic" as const,
  };

  if (!serp) {
    return {
      ...base,
      kind: "none",
      zoeRank: null,
      competitorsAhead: [],
      headline: "No SERP read yet",
      detail: `"${opp.keyword}" has not been read on Google yet, so the competitive position is unknown.`,
      recommendation: "Run the SERP office runner to read this keyword before acting.",
    };
  }

  const zoeRank = serp.zoeRank;
  // Competitor domains ahead of Zoe. competitorRefs already excludes Zoe + directories; when Zoe ranks we keep
  // only those above her position, otherwise all read competitors (best-first). Capped for display.
  const aheadDomains = zoeRank != null ? new Set(serp.topDomains.filter((d) => d.rank < zoeRank).map((d) => d.domain)) : null;
  const competitorsAhead = opp.competitorRefs.filter((d) => aheadDomains == null || aheadDomains.has(d)).slice(0, 5);
  const topList = competitorsAhead.length ? competitorsAhead.join(", ") : "no tracked competitors";
  const action = opp.recommendedAction;
  const actionVerb = action === "IMPROVE" ? "improve the existing page" : action === "CONSOLIDATE" ? "consolidate onto the best page" : action === "CREATE" ? "create a page" : "review";

  if (serp.zoePresent && zoeRank != null && zoeRank <= 3) {
    return {
      ...base,
      kind: "defend",
      zoeRank,
      competitorsAhead,
      headline: `Ranking #${zoeRank} — defend`,
      detail: `Zoe already ranks #${zoeRank} on page 1 for "${opp.keyword}". Limited upside; protect the position.`,
      recommendation: `Keep the page fresh and watch ${topList} so the #${zoeRank} position holds.`,
    };
  }

  if (serp.zoePresent && zoeRank != null) {
    return {
      ...base,
      kind: "improve",
      zoeRank,
      competitorsAhead,
      headline: `Ranking #${zoeRank} — room to climb`,
      detail: `Zoe ranks #${zoeRank} on page 1 for "${opp.keyword}", behind ${topList}.`,
      recommendation: `${cap(actionVerb)} for "${opp.keyword}" to climb past ${topList}.`,
    };
  }

  if (competitorsAhead.length) {
    return {
      ...base,
      kind: "gap",
      zoeRank: null,
      competitorsAhead,
      headline: `Gap — not on page 1`,
      detail: `${competitorsAhead.length} competitor domain(s) own page 1 for "${opp.keyword}" (${topList}); Zoe does not appear.`,
      recommendation: `${cap(actionVerb)} targeting "${opp.keyword}" to break onto page 1 against ${topList}.`,
    };
  }

  return {
    ...base,
    kind: "none",
    zoeRank: null,
    competitorsAhead: [],
    headline: "No clear competitive signal",
    detail: `No tracked competitor and no Zoe listing were read for "${opp.keyword}".`,
    recommendation: "Re-read this keyword, or confirm it is worth targeting.",
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * OPTIONALLY replace the deterministic recommendation with an LLM-phrased one. The model is given ONLY the
 * deterministic facts and asked for one short, human sentence — it may not add rankings/volumes/competitors.
 * Never throws; on any failure or when no LLM is configured, the deterministic finding is returned unchanged.
 */
export async function enrichFinding(finding: SeoFinding): Promise<SeoFinding> {
  if (!llmConfigured() || finding.kind === "none") return finding;
  const facts = [
    `Keyword: ${finding.keyword}`,
    finding.location ? `Location: ${finding.location}` : null,
    finding.zoeRank != null ? `Zoe current rank: #${finding.zoeRank}` : "Zoe not on page 1",
    finding.competitorsAhead.length ? `Competitors ahead: ${finding.competitorsAhead.join(", ")}` : "No tracked competitors ahead",
    finding.action ? `Recommended action: ${finding.action}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const res = await chat(
    [
      {
        role: "user",
        content:
          "You are an SEO analyst for an event-rental company. Using ONLY the facts below, write ONE short, " +
          "plain sentence telling the marketing team the single next action for this keyword. Do not invent any " +
          "ranking, search volume, traffic number, or competitor that is not listed. Do not add a greeting.\n\n" +
          facts,
      },
    ],
    { timeoutMs: 20000, maxTokens: 120, temperature: 0.2 },
  );
  if (!res.ok || !res.text) return finding;
  const text = humanize(res.text.trim());
  if (!text) return finding;
  return { ...finding, recommendation: text, recommendationSource: "llm" };
}

export interface FindingsOptions {
  /** Only gaps + improves (the actionable queue); defaults to all kinds. */
  actionableOnly?: boolean;
  limit?: number;
}

/**
 * The findings for the stored opportunities, newest-priority first. Deterministic (no LLM) — the UI/job calls
 * enrichFinding() per card when it wants LLM phrasing. Honest: an opportunity with no SERP read yields a "none"
 * finding, never a fabricated gap.
 */
export function seoFindings(opts: FindingsOptions = {}): SeoFinding[] {
  const opps = listOpportunities({ limit: opts.limit ?? 500 });
  let findings = opps.map(buildFinding);
  if (opts.actionableOnly) findings = findings.filter((f) => f.kind === "gap" || f.kind === "improve");
  findings.sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1));
  return findings;
}
