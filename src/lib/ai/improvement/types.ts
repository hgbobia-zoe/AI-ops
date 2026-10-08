// Self-Improvement Controller — types. An IMPROVEMENT RUN is one controlled attempt to carry a human's
// improvement request through the full autonomous software-engineering loop. The CONTROLLER owns the
// lifecycle: it decides state transitions, enforces scope + the change budget, and owns the merge/deploy/
// verify/rollback gates. The AI only investigates, plans, writes code, and diagnoses — it never decides
// whether its own safety requirements can be skipped.
//
// Governing law: RULES CONTROL EXECUTION. AI INTERPRETS AND GENERATES CHANGES.

// ── Lifecycle states (the happy path) ───────────────────────────────────────────
export type RunState =
  | "requested" //        a human filed an improvement request against a blade
  | "investigating" //    AI is inspecting the current implementation
  | "planned" //          AI produced an implementation plan (pre-code)
  | "coding" //           AI is modifying code in the isolated workspace
  | "validating" //       the project's validation pipeline is running (typecheck/tests/build)
  | "pr_created" //       a PR has been opened
  | "ci_running" //       CI is validating the PR
  | "ready_to_merge" //   all required gates are green; eligible to merge
  | "merged" //           the PR merged into the base branch
  | "deploying" //        a deployment was triggered
  | "deployed" //         the deployment completed (NOT yet verified)
  | "verifying" //        post-deploy health verification is running
  | "verified" //         health verification passed — the improvement is live and healthy (SUCCESS)
  // ── Failure / hold states ──────────────────────────────────────────────────────
  | "validation_failed" //    local validation failed (may trigger bounded self-repair)
  | "ci_failed" //            CI failed (may trigger bounded self-repair)
  | "scope_exceeded" //       the run moved materially outside its declared scope — stop + review
  | "session_failed" //       an unexpected error broke the run
  | "deployment_failed" //    the deployment itself failed
  | "health_check_failed" //  post-deploy health verification failed
  | "rollback_required" //    a rollback is needed (deploy or health failure)
  | "rolled_back" //          a rollback completed (TERMINAL — change reverted)
  | "human_review_required"; //  the controller stopped and is waiting on a human (TERMINAL until a human acts)

export const ALL_RUN_STATES: RunState[] = [
  "requested", "investigating", "planned", "coding", "validating", "pr_created", "ci_running",
  "ready_to_merge", "merged", "deploying", "deployed", "verifying", "verified",
  "validation_failed", "ci_failed", "scope_exceeded", "session_failed", "deployment_failed",
  "health_check_failed", "rollback_required", "rolled_back", "human_review_required",
];

/** States from which the run can no longer advance on its own (a human must act, or it is done). */
export const TERMINAL_RUN_STATES: RunState[] = ["verified", "rolled_back", "human_review_required"];

/** The failure/hold states (not the happy path). */
export const FAILURE_RUN_STATES: RunState[] = [
  "validation_failed", "ci_failed", "scope_exceeded", "session_failed", "deployment_failed",
  "health_check_failed", "rollback_required", "rolled_back", "human_review_required",
];

// ── Scope (gate 1) ──────────────────────────────────────────────────────────────
export interface RunScope {
  blade: string; //               the single blade being improved
  summary: string; //             what the improvement is
  problem: string; //             the problem being solved
  /** Glob-ish path prefixes the run is ALLOWED to modify (controller-enforced). */
  allowedPaths: string[];
  /** Path prefixes explicitly OUT of scope — a touch here trips scope_exceeded regardless of allowedPaths. */
  forbiddenPaths: string[];
}

// ── Change budget (gate 4) — configurable, never arbitrary ───────────────────────
export interface ChangeBudget {
  maxFiles: number; //        distinct files the run may modify
  maxLines: number; //        total added+removed lines
  maxDirs: number; //         distinct top-level directories touched
  maxCommands: number; //     shell commands executed
  maxRetries: number; //      bounded self-repair cycles after a validation/CI failure
  maxWallClockMin: number; // wall-clock budget for the whole run
}

/** What the run has actually consumed so far (the controller compares this to the budget). */
export interface RunMetrics {
  files: number;
  lines: number;
  dirs: number;
  commands: number;
  retries: number;
  elapsedMin: number;
}

export const ZERO_METRICS: RunMetrics = { files: 0, lines: 0, dirs: 0, commands: 0, retries: 0, elapsedMin: 0 };

// ── Deployment + health ──────────────────────────────────────────────────────────
export interface DeployInfo {
  provider: string | null; //   e.g. "fly"
  deployId: string | null; //   release/version id (for rollback)
  previousId: string | null; // the release to roll back to
  status: string | null; //     provider-reported status
}

export interface HealthResult {
  healthy: boolean;
  checkedAt: string;
  detail: string; //      human-readable summary of what was checked
  failures: string[]; //  specific failing checks (empty when healthy)
}

// ── The run record ────────────────────────────────────────────────────────────────
export interface ImprovementRun {
  id: string; //              "IR-"+uuid
  requestId: string | null; // originating ai_requests.id
  blade: string;
  state: RunState;
  scope: RunScope;
  budget: ChangeBudget;
  metrics: RunMetrics;
  branch: string | null;
  commit: string | null;
  prUrl: string | null;
  prNumber: number | null;
  deploy: DeployInfo | null;
  health: HealthResult | null;
  /** The implementation plan the AI produced before coding (gate 2). */
  plan: string | null;
  /** Honest failure reason when in a failure state. */
  error: string | null;
  startedBy: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface RunEvent {
  id: string;
  runId: string;
  ts: string;
  from: RunState | null;
  to: RunState;
  actor: string; //   "controller" | a human label | "ai"
  note: string | null;
  payload: Record<string, unknown> | null;
}
