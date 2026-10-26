// FI Stage 7c — historical learning / recommendations (audit §6, closing the Profitability program). Two
// layers, in strict order:
//
//   1) DETERMINISTIC FACTS (this module's core, PURE + unit-tested). Assembled from the existing history —
//      per-project margins, labor method/confidence patterns (how often ESTIMATED vs ACTUAL), recurring
//      low-margin categories (via the Stage-6 item-intelligence keywords / event type), and the
//      variance-vs-prior movements already recorded in reconciliation_runs. Every figure is computed from
//      passed-in inputs; nothing is invented.
//   2) AN LLM INTERPRETATION PASS (dormant-safe). The LLM is handed ONLY the computed facts and asked to
//      turn them into plain-language insight + recommendations. It must not state any number not present in
//      the facts, every insight is labeled as AI interpretation, and the house style is enforced
//      (COMMS_STYLE via chat() + the deterministic humanize() strip). When no model is configured it is a
//      clean no-op: the deterministic facts stand alone with an honest "AI interpretation unavailable" note.
//
// Governing law: RULES CALCULATE, AI INTERPRETS, NEVER FABRICATE.

import { chat, llmConfigured } from "@/lib/llm";
import { humanize } from "@/lib/salesos/outreach";
import type { InsightsConfig } from "./config";
import type { ProjectSnapshotStatus, CostStatus } from "./projectSnapshot";
import type { VarianceReason } from "./reconciliationRun";

// ── Inputs (already read by the service; kept as parameters so the core stays pure) ─────────────────

/** One project's profitability + attribution facts for the period (from its snapshot + item intelligence). */
export interface InsightProjectInput {
  projectId: string;
  label: string;
  eventDate: string | null;
  /** Contribution margin (0-1) or null when revenue/cost is unknown — a null margin never counts as 0. */
  marginPct: number | null;
  contribution: number | null;
  revenue: number | null;
  status: ProjectSnapshotStatus;
  directCostStatus: CostStatus;
  /** The worst/most-honest labor attribution method across the project's labor leaves. */
  laborMethod: string | null;
  laborConfidence: string | null;
  /** Item-intelligence keywords that matched this project's titles (category signal). Empty = none matched. */
  keywords: string[];
}

/** A reconciliation run's variance-vs-prior, reduced to the reason+delta of each moved line. */
export interface InsightRunInput {
  projectId: string;
  lines: { reason: VarianceReason; delta: number }[];
}

export interface InsightsInput {
  periodLabel: string;
  projects: InsightProjectInput[];
  runs: InsightRunInput[];
  config: InsightsConfig;
}

// ── Facts (the deterministic output; what the LLM is allowed to interpret) ───────────────────────────

export type InsightCategory = "margin" | "labor_grain" | "category_margin" | "reconciliation_trend";

/** One deterministic fact. `text` is a human-free statement of the computed number(s); `metrics` carries
 *  the raw figures for the UI and for the prompt (the LLM sees only these). */
export interface InsightFact {
  id: string;
  category: InsightCategory;
  text: string;
  metrics: Record<string, number | string | null>;
  /** THIN when the sample is below the configured minimum — surfaced, never asserted as a confident trend. */
  thin?: boolean;
}

export interface CategoryMargin {
  keyword: string;
  count: number;
  avgMarginPct: number;
  /** avgMarginPct − overall avg; negative = this category runs below the book. */
  deltaVsOverallPct: number;
  thin: boolean;
}

export interface InsightOverview {
  marginProjectCount: number;
  avgMarginPct: number | null;
  lowMarginCount: number;
  lowMarginPct: number; // the threshold used (echoed for the UI)
  estimatedLaborCount: number;
  actualLaborCount: number;
  laborProjectCount: number;
  categories: CategoryMargin[];
}

export interface InsightInterpretation {
  summary: string;
  recommendations: { text: string; basedOn: string }[];
  model?: string;
}

export interface InsightsResult {
  periodLabel: string;
  facts: InsightFact[];
  overview: InsightOverview;
  llmAvailable: boolean;
  /** Present only when the LLM ran and returned usable output. Always labeled as interpretation in the UI. */
  interpretation: InsightInterpretation | null;
  /** Honest status line for the interpretation layer (why it is or isn't present). */
  interpretationNote: string;
  llmError?: string;
}

const round = (n: number, p = 2): number => {
  const f = Math.pow(10, p);
  return Math.round(n * f) / f;
};
/** A category must run at least this many margin points below the book to be called out (5 pts). A documented
 *  constant, not a magic number: below it the gap is noise, not a signal worth an interpretation. */
const CATEGORY_GAP = 0.05;

// ── 1) Deterministic fact assembly (PURE) ────────────────────────────────────────────────────────────

/** Compute the deterministic facts + overview from the period's projects and reconciliation runs. PURE. */
export function assembleInsightFacts(input: InsightsInput): { facts: InsightFact[]; overview: InsightOverview } {
  const { projects, runs, config } = input;
  const facts: InsightFact[] = [];

  // Margin distribution (only projects with a known margin — a null margin is excluded, never read as 0).
  const withMargin = projects.filter((p) => p.marginPct != null) as (InsightProjectInput & { marginPct: number })[];
  const avgMargin = withMargin.length > 0 ? round(withMargin.reduce((s, p) => s + p.marginPct, 0) / withMargin.length, 4) : null;
  const lowMarginThreshold = config.lowMarginPct;
  const lowMargin = withMargin.filter((p) => p.marginPct <= lowMarginThreshold);

  if (withMargin.length > 0 && avgMargin != null) {
    facts.push({
      id: "margin.avg",
      category: "margin",
      text: `Across ${withMargin.length} project(s) with a computable margin, the average contribution margin is ${pct(avgMargin)}.`,
      metrics: { projectCount: withMargin.length, avgMarginPct: avgMargin },
    });
    facts.push({
      id: "margin.low",
      category: "margin",
      text: `${lowMargin.length} of ${withMargin.length} project(s) are at or below the ${pct(lowMarginThreshold)} low-margin threshold.`,
      metrics: { lowMarginCount: lowMargin.length, projectCount: withMargin.length, thresholdPct: lowMarginThreshold },
    });
  }

  // Labor grain pattern — how often the attributed labor is still an estimate vs a verified actual. This is
  // the honest signal behind "labor is consistently under-estimated; consider the stop-level upgrade".
  const withLabor = projects.filter((p) => p.laborMethod != null);
  const estimated = withLabor.filter((p) => p.directCostStatus === "ESTIMATED").length;
  const actual = withLabor.filter((p) => p.directCostStatus === "ACTUAL").length;
  if (withLabor.length > 0) {
    facts.push({
      id: "labor.grain",
      category: "labor_grain",
      text: `${estimated} of ${withLabor.length} project(s) have labor costed at estimated (planned) grain rather than a verified actual.`,
      metrics: { estimatedCount: estimated, actualCount: actual, laborProjectCount: withLabor.length },
    });
  }

  // Recurring low-margin categories — group margin-bearing projects by their item-intelligence keyword.
  const byKeyword = new Map<string, number[]>();
  for (const p of withMargin) {
    for (const k of new Set(p.keywords)) {
      const arr = byKeyword.get(k) ?? [];
      arr.push(p.marginPct);
      byKeyword.set(k, arr);
    }
  }
  const categories: CategoryMargin[] = [];
  for (const [keyword, margins] of [...byKeyword.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const avg = round(margins.reduce((s, m) => s + m, 0) / margins.length, 4);
    const thin = margins.length < config.minCategorySample;
    const delta = avgMargin != null ? round(avg - avgMargin, 4) : 0;
    categories.push({ keyword, count: margins.length, avgMarginPct: avg, deltaVsOverallPct: delta, thin });
    // Only assert a trend fact when the sample is sufficient AND the gap is material.
    if (!thin && avgMargin != null && delta <= -CATEGORY_GAP) {
      facts.push({
        id: `category.${keyword}`,
        category: "category_margin",
        text: `Projects with "${keyword}" items average ${pct(avg)} margin across ${margins.length} project(s), ${pct(Math.abs(delta))} below the ${pct(avgMargin)} book average.`,
        metrics: { keyword, count: margins.length, avgMarginPct: avg, deltaVsOverallPct: delta, bookAvgPct: avgMargin },
      });
    } else if (thin && margins.length > 0) {
      facts.push({
        id: `category.${keyword}.thin`,
        category: "category_margin",
        text: `Projects with "${keyword}" items average ${pct(avg)} margin, but on only ${margins.length} project(s) — too thin to call a trend yet.`,
        metrics: { keyword, count: margins.length, avgMarginPct: avg },
        thin: true,
      });
    }
  }

  // Reconciliation-run trend — aggregate the recorded variance reasons. These are facts about what moved,
  // never an inferred motive (the reason tag itself is derived deterministically upstream).
  const reasonCount = new Map<VarianceReason, number>();
  const reasonNet = new Map<VarianceReason, number>();
  for (const r of runs) {
    for (const ln of r.lines) {
      reasonCount.set(ln.reason, (reasonCount.get(ln.reason) ?? 0) + 1);
      reasonNet.set(ln.reason, round((reasonNet.get(ln.reason) ?? 0) + ln.delta, 2));
    }
  }
  const lateTimesheet = reasonCount.get("late_timesheet") ?? 0;
  const laborActualized = reasonCount.get("labor_actualized") ?? 0;
  if (lateTimesheet + laborActualized > 0) {
    facts.push({
      id: "recon.labor_moves",
      category: "reconciliation_trend",
      text: `Labor lines moved after the first snapshot ${lateTimesheet + laborActualized} time(s) this period (${lateTimesheet} from late timesheets, ${laborActualized} from an estimate becoming actual).`,
      metrics: { lateTimesheetCount: lateTimesheet, laborActualizedCount: laborActualized },
    });
  }
  const refunds = reasonCount.get("refund") ?? 0;
  if (refunds > 0) {
    facts.push({
      id: "recon.refunds",
      category: "reconciliation_trend",
      text: `Revenue was credited or refunded on ${refunds} reconciliation line(s), a net ${money(reasonNet.get("refund") ?? 0)} this period.`,
      metrics: { refundLineCount: refunds, netRefund: reasonNet.get("refund") ?? 0 },
    });
  }

  const overview: InsightOverview = {
    marginProjectCount: withMargin.length,
    avgMarginPct: avgMargin,
    lowMarginCount: lowMargin.length,
    lowMarginPct: lowMarginThreshold,
    estimatedLaborCount: estimated,
    actualLaborCount: actual,
    laborProjectCount: withLabor.length,
    categories,
  };
  return { facts, overview };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
function money(n: number): string {
  return (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
}

// ── 2) LLM interpretation (dormant-safe) ─────────────────────────────────────────────────────────────

const INSIGHTS_SYSTEM =
  "You are a financial operations analyst for an event-rental company. You are given a set of ALREADY-COMPUTED, " +
  "deterministic facts about the period's project profitability. Your ONLY job is to INTERPRET those facts into " +
  "plain-language insight and practical recommendations for the operations team. " +
  "HARD RULES: Do not state any number, dollar amount, percentage or count that is not already present in the " +
  "facts you were given. Do not invent trends, costs or causes the facts do not show. If the facts are thin or " +
  "absent, say so plainly rather than guessing. Every sentence must be an interpretation of a given fact. " +
  'Output RAW JSON ONLY, no markdown or code fences, exactly: {"summary": string, "recommendations": ' +
  '[{"text": string, "basedOn": string}]}. "basedOn" is the id of the fact a recommendation rests on. Use an ' +
  "empty recommendations array if nothing actionable stands out.";

/** Build the LLM messages from the facts. PURE — the user turn carries ONLY the computed facts (as JSON), so
 *  the model can only ever see numbers we computed. Exported for the unit test that asserts exactly this. */
export function buildInsightPrompt(facts: InsightFact[], periodLabel: string): { role: "system" | "user"; content: string }[] {
  const payload = {
    period: periodLabel,
    facts: facts.map((f) => ({ id: f.id, category: f.category, statement: f.text, metrics: f.metrics, thin: f.thin ?? false })),
  };
  return [
    { role: "system", content: INSIGHTS_SYSTEM },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

function extractJson(text: string): unknown {
  let s = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}

/**
 * Interpret the deterministic facts with the LLM, dormant-safe. When no model is configured this is a clean
 * no-op (interpretation: null + honest note) — the facts stand alone, never fabricated into prose. All model
 * output is run through humanize() so the house style (no dashes, no emoji) holds even if the model slips.
 */
export async function interpretInsights(facts: InsightFact[], periodLabel: string): Promise<{ interpretation: InsightInterpretation | null; note: string; error?: string }> {
  if (facts.length === 0) {
    return { interpretation: null, note: "No facts to interpret this period — nothing is inferred from an empty set." };
  }
  if (!llmConfigured()) {
    return {
      interpretation: null,
      note: "AI interpretation unavailable — no language model is configured. The facts above are shown on their own and nothing is inferred.",
    };
  }
  const r = await chat(buildInsightPrompt(facts, periodLabel), { json: true, timeoutMs: 45000 });
  if (!r.ok || !r.text) {
    return { interpretation: null, note: "AI interpretation unavailable — the model did not respond. The facts above stand on their own.", error: r.error };
  }
  try {
    const parsed = extractJson(r.text) as { summary?: unknown; recommendations?: unknown };
    const recs = Array.isArray(parsed.recommendations)
      ? parsed.recommendations
          .map((x) => x as { text?: unknown; basedOn?: unknown })
          .map((x) => ({ text: humanize(typeof x.text === "string" ? x.text : ""), basedOn: typeof x.basedOn === "string" ? x.basedOn : "" }))
          .filter((x) => x.text.length > 0)
      : [];
    const summary = humanize(typeof parsed.summary === "string" ? parsed.summary : "");
    if (!summary && recs.length === 0) {
      return { interpretation: null, note: "AI interpretation unavailable — the model returned nothing usable. The facts above stand on their own." };
    }
    return {
      interpretation: { summary, recommendations: recs, model: r.model },
      note: "Interpreted by a language model from the deterministic facts above. Treat it as interpretation, not a new fact.",
    };
  } catch {
    return { interpretation: null, note: "AI interpretation unavailable — the model did not return valid output. The facts above stand on their own." };
  }
}
