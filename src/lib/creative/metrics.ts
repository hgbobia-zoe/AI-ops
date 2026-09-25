// Creative Engine — Provider Benchmarking metrics. PURE + deterministic (no DB): every number is COMPUTED
// from the rows, never stored, so it can never go stale and is always explainable. Human evaluation and the
// automated QA are kept SEPARATE — they are never blended into one score. Cost figures come from the real
// generation callback meta; when absent the figure is `null` (rendered "unknown"), never fabricated.

import {
  type ProviderMetrics,
  type ExperimentProvider,
  type ExperimentRun,
  type HumanEval,
  type FailureReason,
  type RunGenerationView,
  type RunCost,
  type FailureCategory,
  FAILURE_CATEGORIES,
} from "./experimentTypes";
import type { QaReport } from "./types";

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Parse an honest RunCost from a generation's stored result meta. Absent/unparseable → known:false. */
export function parseCost(meta: Record<string, unknown> | null | undefined): RunCost {
  const empty: RunCost = { total: null, input: null, output: null, currency: "USD", known: false };
  if (!meta || typeof meta !== "object") return empty;
  const c = (meta as Record<string, unknown>).cost;
  if (!c || typeof c !== "object") return empty;
  const o = c as Record<string, unknown>;
  const total = num(o.usd) ?? num(o.total) ?? num(o.totalUsd) ?? num(o.totalCost) ?? num(o.amount);
  const input = num(o.input) ?? num(o.inputUsd) ?? num(o.inputCost);
  const output = num(o.output) ?? num(o.outputUsd) ?? num(o.outputCost);
  const currency = typeof o.currency === "string" ? o.currency : "USD";
  const known = total != null || input != null || output != null;
  return { total: total ?? (input != null || output != null ? (input ?? 0) + (output ?? 0) : null), input, output, currency, known };
}

export function parseProcessingMs(meta: Record<string, unknown> | null | undefined): number | null {
  if (!meta || typeof meta !== "object") return null;
  return num((meta as Record<string, unknown>).processingMs) ?? num((meta as Record<string, unknown>).processing_ms);
}

/** A run's generation produced a usable image (not pending, not errored). */
export function runProduced(gen: RunGenerationView | undefined): boolean {
  if (!gen) return false;
  return !!gen.resultPath && gen.status !== "error" && gen.status !== "generating";
}

const qaPassed = (qa: QaReport | null): boolean => !!qa && qa.verdict === "pass";
const dim = (qa: QaReport | null, key: keyof NonNullable<QaReport["dimensions"]>): number | null =>
  qa?.dimensions ? num(qa.dimensions[key]) : null;

const avg = (xs: (number | null)[]): number | null => {
  const vals = xs.filter((x): x is number => x != null);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
};
const rate = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null); // % with 1 decimal

function emptyFailureModes(): Record<FailureCategory, number> {
  const out = {} as Record<FailureCategory, number>;
  for (const c of FAILURE_CATEGORIES) out[c.key] = 0;
  return out;
}

/** Compute per-provider metrics for an experiment. `generations` is keyed by generationId. */
export function computeMetrics(
  providers: ExperimentProvider[],
  runs: ExperimentRun[],
  evals: HumanEval[],
  failures: FailureReason[],
  generations: Record<string, RunGenerationView>,
): ProviderMetrics[] {
  const evalByRun = new Map(evals.map((e) => [e.runId, e]));
  const failuresByRun = new Map<string, FailureReason[]>();
  for (const f of failures) {
    const arr = failuresByRun.get(f.runId) ?? [];
    arr.push(f);
    failuresByRun.set(f.runId, arr);
  }

  return providers.map((p) => {
    const pRuns = runs.filter((r) => r.providerRefId === p.id);
    const gens = pRuns.map((r) => (r.generationId ? generations[r.generationId] : undefined));

    const successful = pRuns.filter((r, i) => runProduced(gens[i])).length;
    const qaReports = pRuns.map((_, i) => gens[i]?.qaReport ?? null);
    const aiQaPass = qaReports.filter((qa) => qaPassed(qa)).length;

    const evaluated = pRuns.filter((r) => evalByRun.has(r.id)).length;
    const humanApproved = pRuns.filter((r) => evalByRun.get(r.id)?.overallApproval === "pass").length;
    const publishable = pRuns.filter((r, i) => qaPassed(gens[i]?.qaReport ?? null) && evalByRun.get(r.id)?.overallApproval === "pass").length;

    const costs = pRuns.map((_, i) => (gens[i] ? gens[i]!.cost : null));
    const costKnown = costs.some((c) => c?.known);
    const totalCost = costs.reduce((sum, c) => (c?.total != null ? sum + c.total : sum), 0);
    const costCount = costs.filter((c) => c?.total != null).length;
    const avgCost = costCount > 0 ? Math.round((totalCost / costCount) * 10000) / 10000 : null;
    const costPerApproved = costKnown && humanApproved > 0 ? Math.round((totalCost / humanApproved) * 10000) / 10000 : null;

    const failureModes = emptyFailureModes();
    for (const r of pRuns) {
      for (const f of failuresByRun.get(r.id) ?? []) failureModes[f.category] = (failureModes[f.category] ?? 0) + 1;
    }

    return {
      providerRefId: p.id,
      providerId: p.providerId,
      providerName: p.providerName,
      model: p.model,
      blindLabel: p.blindLabel,
      generations: pRuns.length,
      successful,
      aiQaPass,
      humanApproved,
      publishable,
      evaluated,
      successRate: rate(successful, pRuns.length),
      qaPassRate: rate(aiQaPass, successful),
      humanApprovalRate: rate(humanApproved, evaluated),
      publishableRate: rate(publishable, pRuns.length),
      avgQaScore: avg(qaReports.map((qa) => (qa ? num(qa.score) : null))),
      avgProductAccuracy: avg(qaReports.map((qa) => dim(qa, "productAccuracy"))),
      avgBrandAlignment: avg(qaReports.map((qa) => dim(qa, "brandAlignment"))),
      avgWebUsability: avg(qaReports.map((qa) => dim(qa, "webUsability"))),
      avgGenerationTimeMs: avg(pRuns.map((_, i) => gens[i]?.processingMs ?? null)),
      avgCost,
      costPerApproved,
      costKnown,
      failureModes,
    };
  });
}
