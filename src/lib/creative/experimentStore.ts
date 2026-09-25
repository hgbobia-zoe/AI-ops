// Creative Engine — Provider Benchmarking persistence (server-only; imports getDb). Deterministic writes,
// no fabrication. Experiments own the FROZEN inputs; providers/cases/runs are children; evals + failures are
// the human layer. Everything the client sees comes back through the pure shapes in experimentTypes.ts.
// This module NEVER writes to creative_jobs / creative_generations / creative_images — it only links to them.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/index";
import {
  type CreativeExperiment,
  type ExperimentProvider,
  type ExperimentTestCase,
  type ExperimentRun,
  type HumanEval,
  type FailureReason,
  type ExperimentStatus,
  type ExperimentPhase,
  type RunStatus,
  type FrozenInputs,
  type EvalDecision,
  type Verdict,
  type FailureCategory,
  isFailureCategory,
} from "./experimentTypes";
import type { AspectRatio, AssetType } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const now = (): string => new Date().toISOString();
const parseArr = (v: unknown): string[] => {
  if (typeof v !== "string" || !v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const parseJson = <T>(v: unknown): T | null => {
  if (typeof v !== "string" || !v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
};

// ── Experiments ───────────────────────────────────────────────────────────────────────────────────────
function toExperiment(r: any, providers: ExperimentProvider[]): CreativeExperiment {
  const frozen: FrozenInputs = {
    sourceImageIds: parseArr(r.source_image_ids),
    briefId: r.brief_id ?? null,
    visualDnaVersion: r.visual_dna_version ?? null,
    aspectRatio: (r.aspect_ratio as AspectRatio) ?? "3:2",
    preserve: parseArr(r.preserve),
    transform: parseArr(r.transform),
    targetAudience: r.target_audience ?? null,
    objective: r.objective ?? null,
    promptVersion: r.prompt_version ?? null,
  };
  return {
    id: String(r.id),
    seq: r.seq == null ? null : Number(r.seq),
    name: r.name,
    description: r.description ?? null,
    status: r.status as ExperimentStatus,
    phase: (Number(r.phase) || 1) as ExperimentPhase,
    assetType: (r.asset_type as AssetType) ?? "lifestyle",
    frozen,
    targetGenerationsPerProvider: Number(r.target_generations_per_provider ?? 1),
    blinding: !!r.blinding,
    autoQa: !!r.auto_qa,
    humanEval: !!r.human_eval,
    costTracking: !!r.cost_tracking,
    providers,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
  };
}

export interface CreateExperimentInput {
  name: string;
  description?: string | null;
  phase?: ExperimentPhase;
  assetType?: AssetType;
  sourceImageIds: string[];
  briefId?: string | null;
  aspectRatio: AspectRatio;
  preserve?: string[];
  transform?: string[];
  targetAudience?: string | null;
  objective?: string | null;
  targetGenerationsPerProvider?: number;
  blinding?: boolean;
  autoQa?: boolean;
  humanEval?: boolean;
  costTracking?: boolean;
  providers: { providerId: string; providerName: string; model: string | null; enabled: boolean; blindLabel: string }[];
}

function nextExperimentSeq(): number {
  const row = getDb().prepare("SELECT MAX(seq) AS m FROM creative_experiments").get() as { m: number | null };
  return (row?.m ?? 0) + 1;
}

export function createExperiment(input: CreateExperimentInput, actor: string | null): CreativeExperiment {
  const id = `CX-${randomUUID()}`;
  const ts = now();
  const seq = nextExperimentSeq();
  getDb()
    .prepare(
      `INSERT INTO creative_experiments (id, seq, name, description, status, phase, asset_type, source_image_ids,
         brief_id, visual_dna_version, visual_dna_snapshot, aspect_ratio, preserve, transform, target_audience,
         objective, prompt_version, target_generations_per_provider, blinding, auto_qa, human_eval, cost_tracking,
         created_by, created_at, started_at, completed_at)
       VALUES (@id,@seq,@name,@description,'draft',@phase,@assetType,@sourceImageIds,@briefId,NULL,NULL,@aspectRatio,
         @preserve,@transform,@targetAudience,@objective,NULL,@tgpp,@blinding,@autoQa,@humanEval,@costTracking,
         @createdBy,@ts,NULL,NULL)`,
    )
    .run({
      id,
      seq,
      name: input.name.trim() || `Experiment ${seq}`,
      description: input.description?.trim() || null,
      phase: input.phase ?? 1,
      assetType: input.assetType ?? "lifestyle",
      sourceImageIds: JSON.stringify(input.sourceImageIds ?? []),
      briefId: input.briefId?.trim() || null,
      aspectRatio: input.aspectRatio,
      preserve: JSON.stringify(input.preserve ?? []),
      transform: JSON.stringify(input.transform ?? []),
      targetAudience: input.targetAudience?.trim() || null,
      objective: input.objective?.trim() || null,
      tgpp: Math.max(1, Math.floor(input.targetGenerationsPerProvider ?? 1)),
      blinding: input.blinding === false ? 0 : 1,
      autoQa: input.autoQa === false ? 0 : 1,
      humanEval: input.humanEval === false ? 0 : 1,
      costTracking: input.costTracking === false ? 0 : 1,
      createdBy: actor,
      ts,
    });
  input.providers.forEach((p, i) => {
    getDb()
      .prepare(
        `INSERT INTO creative_experiment_providers (id, experiment_id, provider_id, provider_name, model, enabled, blind_label, sort_order, created_at)
         VALUES (@id,@experimentId,@providerId,@providerName,@model,@enabled,@blindLabel,@sortOrder,@ts)`,
      )
      .run({
        id: `CXP-${randomUUID()}`,
        experimentId: id,
        providerId: p.providerId,
        providerName: p.providerName,
        model: p.model?.trim() || null,
        enabled: p.enabled ? 1 : 0,
        blindLabel: p.blindLabel,
        sortOrder: i,
        ts,
      });
  });
  return getExperiment(id)!;
}

function toProvider(r: any): ExperimentProvider {
  return {
    id: String(r.id),
    providerId: r.provider_id,
    providerName: r.provider_name,
    model: r.model ?? null,
    enabled: !!r.enabled,
    blindLabel: r.blind_label,
    sortOrder: Number(r.sort_order ?? 0),
  };
}

export function listExperimentProviders(experimentId: string): ExperimentProvider[] {
  return (getDb().prepare("SELECT * FROM creative_experiment_providers WHERE experiment_id = ? ORDER BY sort_order").all(experimentId) as any[]).map(toProvider);
}

export function getExperiment(id: string): CreativeExperiment | null {
  const r = getDb().prepare("SELECT * FROM creative_experiments WHERE id = ?").get(id);
  if (!r) return null;
  return toExperiment(r, listExperimentProviders(id));
}

export function listExperiments(): CreativeExperiment[] {
  const rows = getDb().prepare("SELECT * FROM creative_experiments ORDER BY created_at DESC").all() as any[];
  return rows.map((r) => toExperiment(r, listExperimentProviders(String(r.id))));
}

/** Server-only: the frozen Visual DNA snapshot stored at start (not part of the client shape). */
export function getExperimentDnaSnapshot(id: string): unknown | null {
  const r = getDb().prepare("SELECT visual_dna_snapshot FROM creative_experiments WHERE id = ?").get(id) as { visual_dna_snapshot: string | null } | undefined;
  return r?.visual_dna_snapshot ? parseJson(r.visual_dna_snapshot) : null;
}

/** Freeze the DNA snapshot + version + prompt version + started_at and flip status → running. */
export function markExperimentStarted(id: string, freeze: { dnaSnapshot: unknown; dnaVersion: string; promptVersion: string }): void {
  getDb()
    .prepare(
      `UPDATE creative_experiments SET status='running', started_at=@ts, visual_dna_snapshot=@dna,
         visual_dna_version=@ver, prompt_version=@pv WHERE id=@id`,
    )
    .run({ ts: now(), dna: JSON.stringify(freeze.dnaSnapshot), ver: freeze.dnaVersion, pv: freeze.promptVersion, id });
}

export function setExperimentStatus(id: string, status: ExperimentStatus): CreativeExperiment | null {
  const patch = status === "completed" ? ", completed_at=@ts2" : "";
  getDb().prepare(`UPDATE creative_experiments SET status=@status${patch} WHERE id=@id`).run(status === "completed" ? { status, ts2: now(), id } : { status, id });
  return getExperiment(id);
}

// ── Test cases ────────────────────────────────────────────────────────────────────────────────────────
function toCase(r: any): ExperimentTestCase {
  return {
    id: String(r.id),
    experimentId: String(r.experiment_id),
    seq: Number(r.seq),
    sourceImageId: r.source_image_id,
    sourceVersion: r.source_version ?? null,
    sourceSnapshot: parseJson(r.source_snapshot),
    jobId: r.job_id ?? null,
    preference: r.preference ?? null,
    preferenceNote: r.preference_note ?? null,
    preferenceBy: r.preference_by ?? null,
    preferenceAt: r.preference_at ?? null,
    createdAt: r.created_at,
  };
}

export function insertCase(c: {
  experimentId: string;
  seq: number;
  sourceImageId: string;
  sourceVersion: string | null;
  sourceSnapshot: unknown;
  jobId: string | null;
}): ExperimentTestCase {
  const id = `CXC-${randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO creative_experiment_cases (id, experiment_id, seq, source_image_id, source_version, source_snapshot, job_id, created_at)
       VALUES (@id,@experimentId,@seq,@sourceImageId,@sourceVersion,@sourceSnapshot,@jobId,@ts)`,
    )
    .run({
      id,
      experimentId: c.experimentId,
      seq: c.seq,
      sourceImageId: c.sourceImageId,
      sourceVersion: c.sourceVersion,
      sourceSnapshot: c.sourceSnapshot ? JSON.stringify(c.sourceSnapshot) : null,
      jobId: c.jobId,
      ts: now(),
    });
  return getCase(id)!;
}

export function getCase(id: string): ExperimentTestCase | null {
  const r = getDb().prepare("SELECT * FROM creative_experiment_cases WHERE id = ?").get(id);
  return r ? toCase(r) : null;
}

export function listCases(experimentId: string): ExperimentTestCase[] {
  return (getDb().prepare("SELECT * FROM creative_experiment_cases WHERE experiment_id = ? ORDER BY seq").all(experimentId) as any[]).map(toCase);
}

export function setCasePreference(caseId: string, preference: string | null, note: string | null, actor: string | null): ExperimentTestCase | null {
  getDb()
    .prepare("UPDATE creative_experiment_cases SET preference=@preference, preference_note=@note, preference_by=@by, preference_at=@ts WHERE id=@id")
    .run({ preference, note: note?.trim() || null, by: actor, ts: now(), id: caseId });
  return getCase(caseId);
}

// ── Runs (the matrix cells) ───────────────────────────────────────────────────────────────────────────
function toRun(r: any): ExperimentRun {
  return {
    id: String(r.id),
    experimentId: String(r.experiment_id),
    caseId: String(r.case_id),
    providerRefId: String(r.provider_ref_id),
    providerId: r.provider_id,
    model: r.model ?? null,
    blindLabel: r.blind_label,
    jobId: r.job_id ?? null,
    generationId: r.generation_id ?? null,
    status: r.status as RunStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function insertRun(run: {
  experimentId: string;
  caseId: string;
  providerRefId: string;
  providerId: string;
  model: string | null;
  blindLabel: string;
  jobId: string | null;
}): ExperimentRun {
  const id = `CXR-${randomUUID()}`;
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO creative_experiment_runs (id, experiment_id, case_id, provider_ref_id, provider_id, model, blind_label, job_id, generation_id, status, created_at, updated_at)
       VALUES (@id,@experimentId,@caseId,@providerRefId,@providerId,@model,@blindLabel,@jobId,NULL,'pending',@ts,@ts)`,
    )
    .run({ id, experimentId: run.experimentId, caseId: run.caseId, providerRefId: run.providerRefId, providerId: run.providerId, model: run.model, blindLabel: run.blindLabel, jobId: run.jobId, ts });
  return getRun(id)!;
}

export function getRun(id: string): ExperimentRun | null {
  const r = getDb().prepare("SELECT * FROM creative_experiment_runs WHERE id = ?").get(id);
  return r ? toRun(r) : null;
}

export function listRuns(experimentId: string): ExperimentRun[] {
  return (getDb().prepare("SELECT * FROM creative_experiment_runs WHERE experiment_id = ?").all(experimentId) as any[]).map(toRun);
}

export function setRunGeneration(runId: string, generationId: string | null, status: RunStatus): ExperimentRun | null {
  getDb().prepare("UPDATE creative_experiment_runs SET generation_id=@gid, status=@status, updated_at=@ts WHERE id=@id").run({ gid: generationId, status, ts: now(), id: runId });
  return getRun(runId);
}

export function setRunStatus(runId: string, status: RunStatus): void {
  getDb().prepare("UPDATE creative_experiment_runs SET status=@status, updated_at=@ts WHERE id=@id").run({ status, ts: now(), id: runId });
}

// ── Human evaluations ─────────────────────────────────────────────────────────────────────────────────
function toEval(r: any): HumanEval {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    experimentId: String(r.experiment_id),
    caseId: String(r.case_id),
    productAccuracy: (r.product_accuracy as Verdict) ?? null,
    realism: (r.realism as Verdict) ?? null,
    brandFit: (r.brand_fit as Verdict) ?? null,
    composition: (r.composition as Verdict) ?? null,
    usability: (r.usability as Verdict) ?? null,
    overallApproval: (r.overall_approval as Verdict) ?? null,
    decision: (r.decision as EvalDecision) ?? null,
    notes: r.notes ?? null,
    evaluator: r.evaluator ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getEval(runId: string): HumanEval | null {
  const r = getDb().prepare("SELECT * FROM creative_experiment_evals WHERE run_id = ?").get(runId);
  return r ? toEval(r) : null;
}

export function listEvals(experimentId: string): HumanEval[] {
  return (getDb().prepare("SELECT * FROM creative_experiment_evals WHERE experiment_id = ?").all(experimentId) as any[]).map(toEval);
}

export interface EvalInput {
  productAccuracy: Verdict | null;
  realism: Verdict | null;
  brandFit: Verdict | null;
  composition: Verdict | null;
  usability: Verdict | null;
  overallApproval: Verdict | null;
  decision: EvalDecision | null;
  notes: string | null;
}

/** Upsert the human eval for a run (re-evaluating overwrites). Returns the stored eval. */
export function upsertEval(run: ExperimentRun, input: EvalInput, actor: string | null): HumanEval {
  const existing = getEval(run.id);
  const ts = now();
  if (existing) {
    getDb()
      .prepare(
        `UPDATE creative_experiment_evals SET product_accuracy=@pa, realism=@re, brand_fit=@bf, composition=@co,
           usability=@us, overall_approval=@oa, decision=@dec, notes=@notes, evaluator=@ev, updated_at=@ts WHERE run_id=@runId`,
      )
      .run({ pa: input.productAccuracy, re: input.realism, bf: input.brandFit, co: input.composition, us: input.usability, oa: input.overallApproval, dec: input.decision, notes: input.notes?.trim() || null, ev: actor, ts, runId: run.id });
    return getEval(run.id)!;
  }
  getDb()
    .prepare(
      `INSERT INTO creative_experiment_evals (id, run_id, experiment_id, case_id, product_accuracy, realism, brand_fit,
         composition, usability, overall_approval, decision, notes, evaluator, created_at, updated_at)
       VALUES (@id,@runId,@experimentId,@caseId,@pa,@re,@bf,@co,@us,@oa,@dec,@notes,@ev,@ts,@ts)`,
    )
    .run({
      id: `CXE-${randomUUID()}`,
      runId: run.id,
      experimentId: run.experimentId,
      caseId: run.caseId,
      pa: input.productAccuracy,
      re: input.realism,
      bf: input.brandFit,
      co: input.composition,
      us: input.usability,
      oa: input.overallApproval,
      dec: input.decision,
      notes: input.notes?.trim() || null,
      ev: actor,
      ts,
    });
  return getEval(run.id)!;
}

// ── Failure reasons ───────────────────────────────────────────────────────────────────────────────────
function toFailure(r: any): FailureReason {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    experimentId: String(r.experiment_id),
    category: r.category as FailureCategory,
    note: r.note ?? null,
    createdAt: r.created_at,
  };
}

export function listFailures(experimentId: string): FailureReason[] {
  return (getDb().prepare("SELECT * FROM creative_experiment_failures WHERE experiment_id = ?").all(experimentId) as any[]).map(toFailure);
}

/** Replace the structured failure reasons for a run (idempotent: clears then re-inserts). */
export function replaceFailures(run: ExperimentRun, reasons: { category: string; note?: string | null }[]): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM creative_experiment_failures WHERE run_id = ?").run(run.id);
    for (const r of reasons) {
      if (!isFailureCategory(r.category)) continue;
      db.prepare(
        `INSERT INTO creative_experiment_failures (id, run_id, experiment_id, category, note, created_at)
         VALUES (@id,@runId,@experimentId,@category,@note,@ts)`,
      ).run({ id: `CXF-${randomUUID()}`, runId: run.id, experimentId: run.experimentId, category: r.category, note: (r.note ?? "").trim() || null, ts: now() });
    }
  });
  tx();
}

/* eslint-enable @typescript-eslint/no-explicit-any */
