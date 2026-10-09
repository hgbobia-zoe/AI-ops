// Self-Improvement Controller — the change budget (audit gate 4). The controller compares what a run has
// actually consumed against configurable limits and, if any are exceeded, trips the run to scope_exceeded
// (→ human review). Limits are configurable (never arbitrary) and live in settings/env, not here. PURE.

import type { ChangeBudget, RunMetrics } from "./types";

/** A sane default budget — deliberately generous enough for a real blade change, bounded enough that a
 *  runaway can't rewrite half the app. Overridden by settings (see config.ts). */
export const DEFAULT_BUDGET: ChangeBudget = {
  maxFiles: 25,
  maxLines: 1500,
  maxDirs: 8,
  maxCommands: 200,
  maxRetries: 3,
  maxWallClockMin: 45,
};

export interface BudgetCheck {
  ok: boolean;
  /** Human-readable reasons a limit was exceeded (empty when ok). */
  exceeded: string[];
}

/** Compare consumed metrics against the budget. PURE. Any breach makes ok=false and names every limit hit. */
export function checkBudget(metrics: RunMetrics, budget: ChangeBudget): BudgetCheck {
  const exceeded: string[] = [];
  if (metrics.files > budget.maxFiles) exceeded.push(`files ${metrics.files} > ${budget.maxFiles}`);
  if (metrics.lines > budget.maxLines) exceeded.push(`lines ${metrics.lines} > ${budget.maxLines}`);
  if (metrics.dirs > budget.maxDirs) exceeded.push(`dirs ${metrics.dirs} > ${budget.maxDirs}`);
  if (metrics.commands > budget.maxCommands) exceeded.push(`commands ${metrics.commands} > ${budget.maxCommands}`);
  if (metrics.retries > budget.maxRetries) exceeded.push(`retries ${metrics.retries} > ${budget.maxRetries}`);
  if (metrics.elapsedMin > budget.maxWallClockMin) exceeded.push(`elapsed ${metrics.elapsedMin}m > ${budget.maxWallClockMin}m`);
  return { ok: exceeded.length === 0, exceeded };
}

/** Has the run exhausted its self-repair retries? (checked before a validation_failed/ci_failed -> coding
 *  bounded-repair transition, so the loop can never run forever). PURE. */
export function retriesExhausted(metrics: RunMetrics, budget: ChangeBudget): boolean {
  return metrics.retries >= budget.maxRetries;
}

/** Merge a partial override onto the default budget (from settings). Non-positive/NaN values are ignored so
 *  a bad config can never produce a zero/negative budget. PURE. */
export function resolveBudget(override: Partial<ChangeBudget> | null | undefined): ChangeBudget {
  const out = { ...DEFAULT_BUDGET };
  if (override) {
    for (const k of Object.keys(DEFAULT_BUDGET) as (keyof ChangeBudget)[]) {
      const v = override[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
  }
  return out;
}
