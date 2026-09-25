// Creative Engine — Provider Benchmarking orchestration (server-only). Ties the experiment tables to the
// EXISTING Creative Engine: it reuses createJob + the Art Director brief + generateForJob + the async n8n
// handoff + the 8-axis QA + the callback idempotency — it does NOT reimplement any of them.
//
// THE EXPERIMENT INVARIANT (spec): every provider in a test case receives the IDENTICAL creative input. We
// guarantee it by construction — one frozen Image Brief is built ONCE per test case and COPIED verbatim onto
// each provider's job, so the brief snapshot every generation freezes is byte-identical. Only provider/model
// (the prescriptive directive) differs. Inputs are frozen at start and never silently changed.

import {
  createJob,
  setJobBrief,
  getImage,
  getGeneration,
} from "./store";
import { ensureBrief, generateForJob } from "./service";
import { getVisualDNA, dnaVersion } from "./visualDna";
import {
  getExperiment,
  listCases,
  listRuns,
  listEvals,
  listFailures,
  insertCase,
  insertRun,
  setRunGeneration,
  setRunStatus,
  markExperimentStarted,
  setExperimentStatus,
  getRun,
  getCase,
  upsertEval,
  replaceFailures,
  setCasePreference,
  type EvalInput,
} from "./experimentStore";
import { computeMetrics, parseCost, parseProcessingMs, runProduced } from "./metrics";
import {
  type CreativeExperiment,
  type ExperimentDetail,
  type ExperimentRun,
  type RunGenerationView,
  type RunStatus,
} from "./experimentTypes";
import type { Generation } from "./types";

// ── Build a client-safe view of a reused creative_generations row ──────────────────────────────────────
function toGenerationView(gen: Generation): RunGenerationView {
  return {
    id: gen.id,
    provider: gen.provider, // the ACTUAL executor (honest; may be "mock"/"n8n"), distinct from the declared provider
    model: gen.model,
    resultPath: gen.resultPath,
    placeholder: gen.placeholder,
    status: gen.status,
    qaReport: gen.qaReport,
    qaScore: gen.qaScore,
    cost: parseCost(gen.resultMeta),
    processingMs: parseProcessingMs(gen.resultMeta),
    createdAt: gen.createdAt,
  };
}

/** Derive the coarse run status from its linked generation (recomputed at read time — never a stored fact). */
function deriveRunStatus(gen: Generation | null): RunStatus {
  if (!gen) return "pending";
  if (gen.status === "error") return "failed";
  if (gen.status === "generating") return "generating";
  return runProduced(toGenerationView(gen)) ? "succeeded" : "failed";
}

// ── Start an experiment ───────────────────────────────────────────────────────────────────────────────
export interface StartOutcome {
  ok: boolean;
  error?: string;
  experiment?: CreativeExperiment;
}

/** Freeze the inputs, build the matrix (case × provider), and enqueue one generation per enabled provider.
 *  Idempotent-ish: refuses to start anything but a draft. */
export async function startExperiment(id: string, actor: string | null, origin: string): Promise<StartOutcome> {
  const exp = getExperiment(id);
  if (!exp) return { ok: false, error: "not_found" };
  if (exp.status !== "draft") return { ok: false, error: "already_started" };
  const enabled = exp.providers.filter((p) => p.enabled);
  if (enabled.length === 0) return { ok: false, error: "no_providers" };
  if (exp.frozen.sourceImageIds.length === 0) return { ok: false, error: "no_sources" };

  // Freeze the Visual DNA snapshot + version + the prompt-composition version. These, plus the per-case brief
  // frozen below, lock the creative input for the whole experiment.
  const dna = getVisualDNA();
  const ver = dnaVersion(dna);
  markExperimentStarted(id, { dnaSnapshot: dna, dnaVersion: ver, promptVersion: ver });

  let seq = 0;
  for (const sourceId of exp.frozen.sourceImageIds) {
    const img = getImage(sourceId);
    if (!img) continue; // a removed source is skipped rather than fabricated
    seq += 1;

    // One clean attempt-1 job PER provider (so each provider's own regeneration attempts, in later phases,
    // stay isolated), but the SAME frozen brief on all of them (the invariant).
    const providerJobs: { providerRefId: string; providerId: string; model: string | null; blindLabel: string; jobId: string }[] = [];
    for (const p of enabled) {
      const job = createJob(
        {
          title: `${exp.name} — case ${String(seq).padStart(3, "0")} · ${p.providerName}`,
          campaign: exp.name,
          assetType: exp.assetType,
          sourceMode: "existing",
          sourceImageId: sourceId,
          aspectRatio: exp.frozen.aspectRatio,
          preserve: exp.frozen.preserve,
          transform: exp.frozen.transform,
          targetAudience: exp.frozen.targetAudience,
          objective: exp.frozen.objective,
        },
        actor,
      );
      providerJobs.push({ providerRefId: p.id, providerId: p.providerId, model: p.model, blindLabel: p.blindLabel, jobId: job.id });
    }

    // Build the brief ONCE (on the first provider's job) and COPY it verbatim to the rest → identical input.
    const first = await ensureBrief(providerJobs[0].jobId, actor);
    const sharedBrief = first?.imageBrief ?? null;
    if (sharedBrief) {
      for (let k = 1; k < providerJobs.length; k++) setJobBrief(providerJobs[k].jobId, sharedBrief, actor);
    }

    const testCase = insertCase({
      experimentId: id,
      seq,
      sourceImageId: sourceId,
      sourceVersion: img.createdAt, // creative_images rows are immutable, so createdAt IS the version
      sourceSnapshot: { id: img.id, path: img.path, name: img.name, mime: img.mime, createdAt: img.createdAt },
      jobId: providerJobs[0].jobId,
    });

    // One generation per enabled provider (Phase 1 = first attempt only). provider+model are PRESCRIPTIVE.
    for (const pj of providerJobs) {
      const run = insertRun({
        experimentId: id,
        caseId: testCase.id,
        providerRefId: pj.providerRefId,
        providerId: pj.providerId,
        model: pj.model,
        blindLabel: pj.blindLabel,
        jobId: pj.jobId,
      });
      let outcome;
      try {
        outcome = await generateForJob(pj.jobId, actor, {
          origin,
          directive: { provider: pj.providerId, model: pj.model, experimentId: id, testCaseId: testCase.id, providerRunId: run.id },
        });
      } catch {
        outcome = { ok: false, generation: undefined } as { ok: boolean; generation?: Generation };
      }
      const gen = outcome.generation ?? null;
      setRunGeneration(run.id, gen?.id ?? null, deriveRunStatus(gen ?? null));
    }
  }

  return { ok: true, experiment: getExperiment(id) ?? exp };
}

// ── Assemble the full detail bundle (experiment + matrix + evals + generations + metrics) ──────────────
/** Reads everything the detail view needs, syncing each run's coarse status from its (async) generation so a
 *  callback that has since landed is reflected without a manual refresh (the UI also polls while running). */
export function buildDetail(id: string): ExperimentDetail | null {
  const experiment = getExperiment(id);
  if (!experiment) return null;
  const cases = listCases(id);
  const runs = listRuns(id);
  const evals = listEvals(id);
  const failures = listFailures(id);

  const generations: Record<string, RunGenerationView> = {};
  const syncedRuns: ExperimentRun[] = runs.map((r) => {
    if (!r.generationId) return r;
    const gen = getGeneration(r.generationId);
    if (!gen) return r;
    generations[gen.id] = toGenerationView(gen);
    const live = deriveRunStatus(gen);
    if (live !== r.status) {
      setRunStatus(r.id, live); // write-through so list views stay fresh (cheap, idempotent)
      return { ...r, status: live };
    }
    return r;
  });

  const metrics = computeMetrics(experiment.providers, syncedRuns, evals, failures, generations);
  return { experiment, cases, runs: syncedRuns, evals, failures, generations, metrics };
}

// ── Human evaluation + preference (kept separate from the automated QA) ────────────────────────────────
export function submitRunEval(
  experimentId: string,
  runId: string,
  input: EvalInput,
  failures: { category: string; note?: string | null }[],
  actor: string | null,
): { ok: boolean; error?: string } {
  const run = getRun(runId);
  if (!run || run.experimentId !== experimentId) return { ok: false, error: "run_not_found" };
  upsertEval(run, input, actor);
  replaceFailures(run, failures ?? []);
  return { ok: true };
}

/** Record the paired preference for a test case ("which would you publish?"): a specific run id, or the
 *  special choices "both" / "neither". A winner is NEVER required. */
export function setCasePreferenceChoice(experimentId: string, caseId: string, choice: string | null, note: string | null, actor: string | null): { ok: boolean; error?: string } {
  const c = getCase(caseId);
  if (!c || c.experimentId !== experimentId) return { ok: false, error: "case_not_found" };
  let value: string | null = null;
  if (choice === "both" || choice === "neither") value = choice;
  else if (choice) {
    const run = getRun(choice);
    if (!run || run.caseId !== caseId) return { ok: false, error: "bad_preference" };
    value = choice;
  }
  setCasePreference(caseId, value, note, actor);
  return { ok: true };
}

/** Complete or archive an experiment (manual lifecycle control). */
export function transitionExperiment(id: string, to: "completed" | "archived" | "running"): CreativeExperiment | null {
  return setExperimentStatus(id, to);
}
