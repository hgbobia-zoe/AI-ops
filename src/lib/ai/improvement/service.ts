// Self-Improvement Controller — the orchestration brain. Every step the AI reports flows through here, and
// the controller applies the RULES: legal state transitions (machine), the scope gate (scope), the change
// budget (budget), bounded self-repair (budget.retries), and the verify→rollback routing. The AI never
// transitions a run or overrides a gate; it only reports progress and the controller decides what happens.
// Server-only (touches the store + config + IO helpers).

import { getRun, transitionRun, updateRunMetrics, setRunArtifacts, setRunDeploy, setRunHealth, createRun, type TransitionResult } from "./store";
import { improvementBudget, autonomyConfig } from "./config";
import { checkScope } from "./scope";
import { checkBudget, retriesExhausted } from "./budget";
import { verifyDeployment } from "./verify";
import { detectDeployment } from "./deploy";
import { rollbackDecision, triggerRollback } from "./rollback";
import type { ImprovementRun, RunScope, RunState, RunMetrics } from "./types";

// ── Open a run ──────────────────────────────────────────────────────────────────
export function openImprovementRun(input: { requestId?: string | null; scope: RunScope; startedBy?: string | null }): ImprovementRun {
  return createRun({ requestId: input.requestId ?? null, scope: input.scope, budget: improvementBudget(), startedBy: input.startedBy ?? null });
}

// ── A plain guarded advance (the AI reports "I reached state X"; the controller allows it or refuses) ──────
export function advance(runId: string, to: RunState, opts: { actor?: string; note?: string; payload?: Record<string, unknown> } = {}): TransitionResult {
  return transitionRun(runId, to, { actor: opts.actor ?? "ai", note: opts.note, payload: opts.payload });
}

/** The AI records its implementation plan (gate 2: plan before code) and the controller advances to planned. */
export function recordPlan(runId: string, plan: string, actor?: string): TransitionResult {
  setRunArtifacts(runId, { plan });
  return transitionRun(runId, "planned", { actor: actor ?? "ai", note: "implementation plan recorded" });
}

// ── Scope gate (gate 1) ────────────────────────────────────────────────────────────
export interface EnforceResult {
  ok: boolean;
  tripped?: RunState; // the state the run was moved to when a rule failed
  detail?: string;
}

/** Enforce scope on the set of paths the AI changed. Any violation stops the run (scope_exceeded) — the AI
 *  cannot proceed outside its declared scope or touch the always-forbidden safety controls. */
export function enforceScope(runId: string, changedPaths: string[]): EnforceResult {
  const run = getRun(runId);
  if (!run) return { ok: false, detail: "not_found" };
  const res = checkScope(changedPaths, run.scope);
  if (res.ok) return { ok: true };
  const detail = res.violations.map((v) => `${v.path} (${v.reason})`).join("; ");
  transitionRun(runId, "scope_exceeded", { actor: "controller", note: `scope violation: ${detail}`, payload: { violations: res.violations } });
  return { ok: false, tripped: "scope_exceeded", detail };
}

// ── Change budget (gate 4) ──────────────────────────────────────────────────────────
/** Record the run's consumed metrics and enforce the budget. A breach stops the run (scope_exceeded = out
 *  of bounds) for a human. */
export function enforceBudget(runId: string, metrics: Partial<RunMetrics>): EnforceResult {
  const run = getRun(runId);
  if (!run) return { ok: false, detail: "not_found" };
  const updated = updateRunMetrics(runId, metrics);
  if (!updated) return { ok: false, detail: "not_found" };
  const check = checkBudget(updated.metrics, run.budget);
  if (check.ok) return { ok: true };
  const detail = check.exceeded.join("; ");
  transitionRun(runId, "scope_exceeded", { actor: "controller", note: `budget exceeded: ${detail}`, payload: { exceeded: check.exceeded } });
  return { ok: false, tripped: "scope_exceeded", detail };
}

// ── Validation + CI with bounded self-repair (gates 5, 7) ───────────────────────────
/** The AI reports local validation (typecheck/tests/build). Pass → pr_created. Fail → validation_failed,
 *  and if the retry budget is spent, escalate straight to a human (no infinite repair). */
export function reportValidation(runId: string, passed: boolean, note?: string): TransitionResult {
  const run = getRun(runId);
  if (!run) return { ok: false, error: "not_found" };
  if (passed) return transitionRun(runId, "pr_created", { actor: "ai", note: note ?? "validation passed" });
  const t = transitionRun(runId, "validation_failed", { actor: "ai", note: note ?? "validation failed" });
  if (!t.ok) return t;
  if (retriesExhausted(run.metrics, run.budget)) {
    return transitionRun(runId, "human_review_required", { actor: "controller", note: "validation failed and retry budget is exhausted" });
  }
  return t;
}

/** The AI (or CI) reports the CI result for the PR. Pass → ready_to_merge. Fail → ci_failed, escalating to a
 *  human when the retry budget is spent. */
export function reportCi(runId: string, passed: boolean, note?: string): TransitionResult {
  const run = getRun(runId);
  if (!run) return { ok: false, error: "not_found" };
  if (passed) return transitionRun(runId, "ready_to_merge", { actor: "controller", note: note ?? "CI green" });
  const t = transitionRun(runId, "ci_failed", { actor: "controller", note: note ?? "CI failed" });
  if (!t.ok) return t;
  if (retriesExhausted(run.metrics, run.budget)) {
    return transitionRun(runId, "human_review_required", { actor: "controller", note: "CI failed and retry budget is exhausted" });
  }
  return t;
}

/** Enter a bounded self-repair cycle (validation_failed|ci_failed → coding). Increments the retry count and
 *  refuses once the budget is spent (→ human_review_required). This is why the loop can never run forever. */
export function retryRepair(runId: string): TransitionResult {
  const run = getRun(runId);
  if (!run) return { ok: false, error: "not_found" };
  if (retriesExhausted(run.metrics, run.budget)) {
    return transitionRun(runId, "human_review_required", { actor: "controller", note: "retry budget exhausted — escalating" });
  }
  updateRunMetrics(runId, { retries: run.metrics.retries + 1 });
  return transitionRun(runId, "coding", { actor: "controller", note: `self-repair attempt ${run.metrics.retries + 1}` });
}

// ── Merge gate (gate 7) ──────────────────────────────────────────────────────────────
/** Record a merge. The controller only auto-advances ready_to_merge → merged when autoMerge is enabled;
 *  otherwise the merge is a human action and this is called after the human merges. Illegal from any other
 *  state (the state machine enforces that only ready_to_merge can become merged). */
export function recordMerge(runId: string, opts: { actor?: string; commit?: string } = {}): TransitionResult {
  if (opts.commit) setRunArtifacts(runId, { commit: opts.commit });
  return transitionRun(runId, "merged", { actor: opts.actor ?? "controller", note: "merged" });
}

/** Is the controller allowed to merge this run on its own right now? (autoMerge enabled AND state is
 *  ready_to_merge). The caller still performs the actual GitHub merge via CI/a scoped token. */
export function mayAutoMerge(run: ImprovementRun): boolean {
  return autonomyConfig().autoMerge && run.state === "ready_to_merge";
}

// ── Deploy detection + verification + rollback routing (gates 8-10) ───────────────────
export interface VerifyOutcome {
  state: RunState;
  healthy: boolean;
  detail: string;
}

/** After a deploy, confirm it is live and run health verification; route to verified or, on failure, decide
 *  rollback vs human review. This is where "deployed" becomes "verified" — or doesn't. `baseUrl` is the live
 *  app. Never throws. */
export async function verifyAndRoute(runId: string, baseUrl: string, repo: string): Promise<VerifyOutcome> {
  const run = getRun(runId);
  if (!run) return { state: "session_failed", healthy: false, detail: "not_found" };

  // 1. Is the merged commit actually serving? (gate 8)
  const dep = await detectDeployment({ baseUrl, expectedCommit: run.commit });
  setRunDeploy(runId, { provider: "fly", deployId: dep.liveCommit, previousId: run.deploy?.deployId ?? null, status: dep.live ? "live" : "unreachable" });
  if (!dep.live) {
    transitionRun(runId, "deployment_failed", { actor: "controller", note: "app unreachable after deploy" });
    return routeUnhealthy(runId, run, repo, "deployment unreachable");
  }

  // 2. Health verification (gate 9).
  const health = await verifyDeployment({ baseUrl, expectedCommit: run.commit });
  setRunHealth(runId, health);
  if (health.healthy) {
    transitionRun(runId, "verified", { actor: "controller", note: health.detail });
    return { state: "verified", healthy: true, detail: health.detail };
  }
  transitionRun(runId, "health_check_failed", { actor: "controller", note: health.failures.join("; ") });
  return routeUnhealthy(runId, run, repo, health.failures.join("; "));
}

/** On an unhealthy deploy: rollback (if enabled + triggerable) else escalate to a human (gate 10). */
async function routeUnhealthy(runId: string, run: ImprovementRun, repo: string, reason: string): Promise<VerifyOutcome> {
  transitionRun(runId, "rollback_required", { actor: "controller", note: reason });
  const decision = rollbackDecision({ healthy: false, checkedAt: new Date().toISOString(), detail: reason, failures: [reason] }, autonomyConfig());
  if (decision.action === "rollback") {
    const trig = await triggerRollback({ repo, previousDeployId: run.deploy?.previousId ?? null, reason });
    if (trig.ok) {
      transitionRun(runId, "rolled_back", { actor: "controller", note: "rollback dispatched" });
      return { state: "rolled_back", healthy: false, detail: "rolled back: " + reason };
    }
    // couldn't trigger — fall through to human
    transitionRun(runId, "human_review_required", { actor: "controller", note: "rollback could not be triggered: " + (trig.error ?? "") });
    return { state: "human_review_required", healthy: false, detail: "rollback failed to trigger — needs a human" };
  }
  transitionRun(runId, "human_review_required", { actor: "controller", note: decision.action === "human_review" ? decision.reason : reason });
  return { state: "human_review_required", healthy: false, detail: reason };
}
