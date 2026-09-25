// Creative Engine — Provider Benchmarking. PURE shapes + option sets shared by the server stores and the
// client surfaces (no DB import; client-safe, mirrors the creative/types.ts split). FACTS + rules only.
//
// A CreativeExperiment is a CONTROLLED image-generation experiment: the SAME creative input (source image +
// its version + brief + Visual DNA version + preserve/transform + aspect ratio + objective + prompt version)
// is handed to every provider; ONLY the provider/model changes. The point is to collect real Zoe data, NOT
// to declare a winner. Human evaluation and the automated QA are tracked SEPARATELY and never blended.

import type { AspectRatio, AssetType, QaReport } from "./types";

// ── Experiment lifecycle ──────────────────────────────────────────────────────────────────────────────
export type ExperimentStatus = "draft" | "running" | "completed" | "archived";
export const EXPERIMENT_STATUSES: ExperimentStatus[] = ["draft", "running", "completed", "archived"];
export const EXPERIMENT_STATUS_LABEL: Record<ExperimentStatus, string> = {
  draft: "Draft",
  running: "Running",
  completed: "Completed",
  archived: "Archived",
};
export const EXPERIMENT_STATUS_PILL: Record<ExperimentStatus, string> = {
  draft: "border-white/15 bg-white/5 text-muted-foreground",
  running: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  completed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  archived: "border-white/10 bg-white/[0.03] text-meta",
};

// ── Phases (data model supports all; Phase 1 implemented) ──────────────────────────────────────────────
// 1 First Attempt — one generation per provider, measure first-pass quality.
// 2 Regeneration — only failed images get another attempt, measure recovery.
// 3 Cost Optimization — quality vs approval vs attempts vs cost → cost per approved image.
export type ExperimentPhase = 1 | 2 | 3;
export const EXPERIMENT_PHASE_LABEL: Record<ExperimentPhase, string> = {
  1: "Phase 1 — First attempt",
  2: "Phase 2 — Regeneration",
  3: "Phase 3 — Cost optimization",
};

// ── Run status (the matrix cell) ──────────────────────────────────────────────────────────────────────
// Recomputed at read time from the linked generation — never a stored derived number.
export type RunStatus = "pending" | "generating" | "succeeded" | "failed";
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  pending: "Queued",
  generating: "Generating",
  succeeded: "Produced",
  failed: "Failed",
};

// ── Human approval criteria (each PASS/FAIL) — spec §9 ─────────────────────────────────────────────────
export type Verdict = "pass" | "fail";
export type EvalCriterion = "productAccuracy" | "realism" | "brandFit" | "composition" | "usability";
export const EVAL_CRITERIA: { key: EvalCriterion; label: string; help: string }[] = [
  { key: "productAccuracy", label: "Product accuracy", help: "Is the rental equipment correct (right tent / tables / chairs / furniture)?" },
  { key: "realism", label: "Realism", help: "Does it read as a real professional photograph?" },
  { key: "brandFit", label: "Brand fit", help: "Does it look like Zoe Events (premium, on-brand)?" },
  { key: "composition", label: "Composition", help: "Does it work in the intended website section?" },
  { key: "usability", label: "Overall usability", help: "Would you actually publish this?" },
];

// The human decision on one image (distinct from the overall PASS/FAIL verdict).
export type EvalDecision = "approve" | "reject" | "needs_revision";
export const EVAL_DECISIONS: { key: EvalDecision; label: string }[] = [
  { key: "approve", label: "Approve" },
  { key: "reject", label: "Reject" },
  { key: "needs_revision", label: "Needs revision" },
];

// ── Paired preference (spec §10) — "Which would you publish?" A winner is NOT required. ────────────────
export type PreferenceChoice = "A" | "B" | "both" | "neither"; // A/B map to run ids; here for the pure catalog
export const PREFERENCE_OPTIONS: { key: "A" | "B" | "both" | "neither"; label: string }[] = [
  { key: "A", label: "Test A" },
  { key: "B", label: "Test B" },
  { key: "both", label: "Both" },
  { key: "neither", label: "Neither" },
];

// ── Failure categories (spec §16) — structured rejection reasons; multiple + free-text allowed. ────────
export type FailureCategory = "PRODUCT" | "PHOTOGRAPHY" | "PEOPLE" | "ARCHITECTURE" | "BRAND" | "WEB";
export const FAILURE_CATEGORIES: { key: FailureCategory; label: string; examples: string[] }[] = [
  { key: "PRODUCT", label: "Product", examples: ["wrong tent", "wrong chair/table", "distorted furniture", "invented equipment"] },
  { key: "PHOTOGRAPHY", label: "Photography", examples: ["unrealistic lighting", "poor composition", "artificial depth", "bad color", "low realism"] },
  { key: "PEOPLE", label: "People", examples: ["hands", "faces", "anatomy", "unnatural behavior"] },
  { key: "ARCHITECTURE", label: "Architecture", examples: ["distorted structure", "impossible perspective", "incorrect geometry"] },
  { key: "BRAND", label: "Brand", examples: ["too generic", "too artificial", "not premium", "wrong color treatment"] },
  { key: "WEB", label: "Web", examples: ["poor crop", "insufficient negative space", "subject placement", "wrong aspect"] },
];
export function isFailureCategory(x: unknown): x is FailureCategory {
  return typeof x === "string" && FAILURE_CATEGORIES.some((c) => c.key === x);
}

// ── Shapes ────────────────────────────────────────────────────────────────────────────────────────────
export interface ExperimentProvider {
  id: string; // CXP-…
  providerId: string; // openai-image | higgsfield | …
  providerName: string;
  model: string | null;
  enabled: boolean;
  blindLabel: string; // A | B | C …
  sortOrder: number;
}

/** The frozen creative inputs — captured at start, never silently changed during the experiment. */
export interface FrozenInputs {
  sourceImageIds: string[];
  briefId: string | null;
  visualDnaVersion: string | null;
  aspectRatio: AspectRatio;
  preserve: string[];
  transform: string[];
  targetAudience: string | null;
  objective: string | null;
  promptVersion: string | null;
}

export interface CreativeExperiment {
  id: string;
  seq: number | null;
  name: string;
  description: string | null;
  status: ExperimentStatus;
  phase: ExperimentPhase;
  assetType: AssetType;
  frozen: FrozenInputs;
  targetGenerationsPerProvider: number;
  blinding: boolean;
  autoQa: boolean;
  humanEval: boolean;
  costTracking: boolean;
  providers: ExperimentProvider[];
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExperimentTestCase {
  id: string;
  experimentId: string;
  seq: number;
  sourceImageId: string;
  sourceVersion: string | null;
  sourceSnapshot: { id: string; path: string; name: string | null; mime: string | null; createdAt: string | null } | null;
  jobId: string | null;
  preference: string | null; // providerRunId | "both" | "neither" | null
  preferenceNote: string | null;
  preferenceBy: string | null;
  preferenceAt: string | null;
  createdAt: string;
}

export interface ExperimentRun {
  id: string;
  experimentId: string;
  caseId: string;
  providerRefId: string;
  providerId: string;
  model: string | null;
  blindLabel: string;
  jobId: string | null;
  generationId: string | null;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface HumanEval {
  id: string;
  runId: string;
  experimentId: string;
  caseId: string;
  productAccuracy: Verdict | null;
  realism: Verdict | null;
  brandFit: Verdict | null;
  composition: Verdict | null;
  usability: Verdict | null;
  overallApproval: Verdict | null;
  decision: EvalDecision | null;
  notes: string | null;
  evaluator: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FailureReason {
  id: string;
  runId: string;
  experimentId: string;
  category: FailureCategory;
  note: string | null;
  createdAt: string;
}

// ── Cost (parsed honestly from the generation callback meta; absent = unknown) ─────────────────────────
export interface RunCost {
  total: number | null; // total estimated USD, or null = unknown
  input: number | null;
  output: number | null;
  currency: string;
  known: boolean;
}

// ── Per-provider computed metrics (spec §14/§17) — DERIVED at read time, never stored. ────────────────
export interface ProviderMetrics {
  providerRefId: string;
  providerId: string;
  providerName: string;
  model: string | null;
  blindLabel: string;
  generations: number; // total runs
  successful: number; // produced an image
  aiQaPass: number; // automated QA verdict pass
  humanApproved: number; // human overall approval pass
  publishable: number; // QA PASS **and** human-approved
  evaluated: number; // runs with a human eval
  // rates (null when the denominator is 0)
  successRate: number | null;
  qaPassRate: number | null; // aiQaPass / successful
  humanApprovalRate: number | null; // humanApproved / evaluated
  publishableRate: number | null; // publishable / generations
  // averages (null = no data; never fabricated)
  avgQaScore: number | null;
  avgProductAccuracy: number | null;
  avgBrandAlignment: number | null;
  avgWebUsability: number | null;
  avgGenerationTimeMs: number | null;
  avgCost: number | null;
  costPerApproved: number | null; // total provider cost ÷ human-approved (spec §15); null = unknown
  costKnown: boolean; // false → every cost figure shows "unknown"
  // failure modes: category → count (across this provider's rejected runs)
  failureModes: Record<FailureCategory, number>;
}

// ── The default template (spec §27) ───────────────────────────────────────────────────────────────────
export interface BenchmarkProviderPreset {
  providerId: string;
  providerName: string;
  model: string;
}
/** Catalog of known providers offered in the create form. Architecture is NOT limited to these — the user
 *  can add any provider id/name/model. Higgsfield is DECLARED here (prescriptive to n8n); its integration is
 *  NOT implemented in the app (n8n is the execution plane). */
export const BENCHMARK_PROVIDER_CATALOG: BenchmarkProviderPreset[] = [
  { providerId: "openai-image", providerName: "OpenAI", model: "gpt-image-1" },
  { providerId: "higgsfield", providerName: "Higgsfield", model: "higgsfield-soul" },
];

export const DEFAULT_TEMPLATE = {
  name: "Zoe Photography Benchmark V1",
  description: "Controlled first-attempt comparison: identical Zoe inputs, one generation per provider. Blinded human evaluation, automated QA, and cost tracking on. Collects real data — it does not declare a winner.",
  phase: 1 as ExperimentPhase,
  assetType: "lifestyle" as AssetType,
  aspectRatio: "3:2" as AspectRatio,
  targetGenerationsPerProvider: 1,
  blinding: true,
  autoQa: true,
  humanEval: true,
  costTracking: true,
  suggestedSourceCount: 10,
  providers: BENCHMARK_PROVIDER_CATALOG,
};

// ── Blind labels ──────────────────────────────────────────────────────────────────────────────────────
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function blindLabelFor(index: number): string {
  if (index < ALPHA.length) return ALPHA[index];
  return `${ALPHA[Math.floor(index / ALPHA.length) - 1]}${ALPHA[index % ALPHA.length]}`;
}

// ── Full detail bundle returned to the client (experiment + everything to render it) ──────────────────
export interface ExperimentDetail {
  experiment: CreativeExperiment;
  cases: ExperimentTestCase[];
  runs: ExperimentRun[];
  evals: HumanEval[];
  failures: FailureReason[];
  // generations keyed by generationId (the reused creative_generations rows — QA + cost + image live here)
  generations: Record<string, RunGenerationView>;
  metrics: ProviderMetrics[];
}

/** The slice of a creative_generations row the benchmark UI needs. QA is the SAME 8-axis report the rest of
 *  the Creative Engine produces (reused, not duplicated). */
export interface RunGenerationView {
  id: string;
  provider: string; // the actual executor (honest: may be "mock"/"n8n"), distinct from the declared provider
  model: string | null;
  resultPath: string | null;
  placeholder: boolean;
  status: string;
  qaReport: QaReport | null;
  qaScore: number | null;
  cost: RunCost;
  processingMs: number | null;
  createdAt: string;
}
