// Quote / Opportunity Analyst — the AI insight store. The sales-ai runtime job runs the LLM reviewQuote
// pass over the top open quotes and records each finding here (kv-backed, capped, deduped by lead). It is
// the auditable, surfaceable record of what the AI actually looked at and flagged — read by the AI Org
// card/detail (lastDetail + an "AI flags" metric) and the Sales OS blade strip. No fabrication: an entry
// exists only because the job genuinely reviewed that quote; `flagged` reflects the model's own output.

import { getJson, setJson } from "@/lib/kv";

const KEY = "salesai.quoteInsights";
/** Keep a small rolling window — enough to surface "what the analyst has been flagging", not a ledger. */
export const MAX_QUOTE_INSIGHTS = 50;

export interface QuoteInsight {
  leadId: string;
  clientName: string;
  eventName: string;
  value: number | null;
  eventDate: string | null;
  quoteAgeDays: number | null;
  stage: string;
  /** The model flagged at least one concrete risk (risky / likely-mispriced / stale logistics). */
  flagged: boolean;
  risks: string[];
  notes: string;
  crew: number;
  /** The model that produced the LLM pass, or null when it fell back to rules only. */
  model: string | null;
  at: string; // ISO
}

export interface QuoteInsightSummary {
  total: number; // insights currently retained
  flagged: number; // how many of those were flagged
  latest: QuoteInsight | null;
  latestAt: string | null;
}

/** PURE. Fold a new insight into the retained list: drop any prior entry for the same lead (latest wins),
 *  newest first, capped at MAX. Exported for unit testing without the kv/DB. */
export function foldInsight(list: QuoteInsight[], insight: QuoteInsight, max: number = MAX_QUOTE_INSIGHTS): QuoteInsight[] {
  const without = list.filter((x) => x.leadId !== insight.leadId);
  return [insight, ...without].slice(0, max);
}

/** PURE. Summarize a retained list for the card/detail. */
export function summarize(list: QuoteInsight[]): QuoteInsightSummary {
  const latest = list[0] ?? null;
  return {
    total: list.length,
    flagged: list.filter((x) => x.flagged).length,
    latest,
    latestAt: latest?.at ?? null,
  };
}

export function listQuoteInsights(limit: number = MAX_QUOTE_INSIGHTS): QuoteInsight[] {
  return getJson<QuoteInsight[]>(KEY, []).slice(0, limit);
}

/** Record one reviewed quote. Best-effort; never throws (storage is a convenience surface, not the gate). */
export function recordQuoteInsight(insight: QuoteInsight): void {
  try {
    setJson(KEY, foldInsight(getJson<QuoteInsight[]>(KEY, []), insight));
  } catch {
    /* best-effort */
  }
}

export function quoteInsightSummary(): QuoteInsightSummary {
  try {
    return summarize(getJson<QuoteInsight[]>(KEY, []));
  } catch {
    return { total: 0, flagged: 0, latest: null, latestAt: null };
  }
}
