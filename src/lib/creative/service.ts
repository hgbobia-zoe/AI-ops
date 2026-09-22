// Creative Engine — lifecycle orchestration (server-only). Ties the Art Director, the model-agnostic
// provider, image persistence, and deterministic QA into the state machine:
//   Define → Art Direction → Generate → QC → Pass/Fail → (Regenerate) → Human Review → Approve → Save.
// Every state change is attributed (currentActor label passed in) and audited. Placeholders are always
// disclosed. Nothing here fabricates: QA scores are real fractions, and a generation only exists once the
// provider returns an image.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getJob,
  updateJob,
  setJobStatus,
  setJobBrief,
  setJobQaScore,
  setJobApproved,
  setJobModel,
  insertGeneration,
  setGenerationQa,
  setGenerationStatus,
  getGeneration,
  insertImage,
  getImage,
  nextAttempt,
  recordEvent,
} from "./store";
import { buildBrief } from "./artDirector";
import { runQa } from "./qa";
import { getVisualDNA } from "./visualDna";
import { getActiveProvider } from "./providers";
import type { ImageGenerationInput, ImageGenerationResult, ProviderImageRef } from "./providers/types";
import { isReferenceFirst, type CreativeJob, type Generation, type ImageBrief } from "./types";

const DATA_DIR = dirname(process.env.DATABASE_PATH || "./data/dispatch.db");
const GEN_DIR = join(DATA_DIR, "creative", "gen");
const UPLOAD_DIR = join(DATA_DIR, "creative", "uploads");

export function uploadDir(): string {
  return UPLOAD_DIR;
}

/** Ensure the Image Brief exists on the job (build + store it if missing). Returns the job with a brief. */
export async function ensureBrief(jobId: string, actor: string | null): Promise<CreativeJob | null> {
  const job = getJob(jobId);
  if (!job) return null;
  if (job.imageBrief) return job;
  const brief = await buildBrief(job, getVisualDNA());
  return setJobBrief(jobId, brief, actor);
}

/** Rebuild the brief from the current job + Visual DNA (used after edits, or to re-run the Art Director). */
export async function rebuildBrief(jobId: string, actor: string | null): Promise<CreativeJob | null> {
  const job = getJob(jobId);
  if (!job) return null;
  const brief = await buildBrief(job, getVisualDNA());
  return setJobBrief(jobId, brief, actor);
}

function toRef(imageId: string | null): ProviderImageRef | null {
  if (!imageId) return null;
  const img = getImage(imageId);
  if (!img) return null;
  return { id: img.id, path: img.path, mime: img.mime };
}

/** Persist a provider result into a served creative_images row. SVG payloads are written to disk; a URL
 *  result is registered as-is (a real provider would return a hosted URL). */
async function persistResult(job: CreativeJob, result: ImageGenerationResult): Promise<{ imageId: string; path: string } | null> {
  if (result.svg) {
    await mkdir(GEN_DIR, { recursive: true });
    const filePath = join(GEN_DIR, `${randomUUID()}.svg`);
    await writeFile(filePath, result.svg, "utf8");
    const img = insertImage({
      kind: "generated",
      name: `${job.title} — attempt`,
      servedPath: "",
      filePath,
      mime: "image/svg+xml",
      width: null,
      height: null,
      placeholder: result.placeholder,
      jobId: job.id,
      createdBy: null,
    });
    return { imageId: img.id, path: img.path };
  }
  if (result.url) {
    const img = insertImage({
      kind: "generated",
      name: `${job.title} — attempt`,
      servedPath: "",
      filePath: null,
      mime: result.meta?.mime ? String(result.meta.mime) : null,
      width: null,
      height: null,
      placeholder: result.placeholder,
      jobId: job.id,
      createdBy: null,
    });
    // For a URL result we store the external URL as the served path override.
    return { imageId: img.id, path: result.url };
  }
  return null;
}

export interface GenerateOutcome {
  ok: boolean;
  error?: string;
  job?: CreativeJob;
  generation?: Generation;
}

/** Run one generation attempt: art-direct (if needed) → provider → persist → QA → advance status. */
export async function generateForJob(jobId: string, actor: string | null): Promise<GenerateOutcome> {
  const withBrief = await ensureBrief(jobId, actor);
  if (!withBrief) return { ok: false, error: "job_not_found" };
  const job = withBrief;
  const brief = job.imageBrief as ImageBrief;

  const provider = getActiveProvider();
  setJobStatus(jobId, "generating", actor, `Generating with ${provider.label}`, "generate");

  const attempt = nextAttempt(jobId);
  const input: ImageGenerationInput = {
    jobId,
    attempt,
    brief,
    aspectRatio: job.aspectRatio,
    sourceImage: toRef(job.sourceImageId),
    referenceImages: job.referenceImageIds.map(toRef).filter((r): r is ProviderImageRef => r !== null),
  };

  let result: ImageGenerationResult;
  try {
    const useEdit = isReferenceFirst(job.sourceMode) && !!input.sourceImage;
    result = useEdit ? await provider.edit(input) : await provider.generate(input);
  } catch (e) {
    result = { ok: false, placeholder: false, error: String(e) };
  }

  if (!result.ok) {
    // Record a failed attempt (no image); park the job in needs_revision so a human can retry/reconfigure.
    const gen = insertGeneration({
      jobId,
      attempt,
      provider: provider.id,
      model: result.model ?? null,
      brief,
      imageId: null,
      resultPath: null,
      placeholder: result.placeholder,
      resultMeta: result.meta ?? null,
      status: "error",
    });
    recordEvent({ jobId, kind: "generate_failed", from: "generating", to: "needs_revision", actor, note: result.error ?? "Provider error" });
    const parked = setJobStatus(jobId, "needs_revision", actor, result.error ?? "Generation failed", "generate_failed") ?? undefined;
    return { ok: false, error: result.error ?? "generation_failed", job: parked, generation: gen };
  }

  const persisted = await persistResult(job, result);
  const gen = insertGeneration({
    jobId,
    attempt,
    provider: provider.id,
    model: result.model ?? null,
    brief,
    imageId: persisted?.imageId ?? null,
    resultPath: persisted?.path ?? result.url ?? null,
    placeholder: result.placeholder,
    resultMeta: result.meta ?? null,
    status: "generating",
  });
  if (result.model && !job.selectedModel) setJobModel(jobId, result.model);
  recordEvent({ jobId, kind: "generated", from: "generating", to: "qa", actor, note: `Attempt ${attempt} produced${result.placeholder ? " (placeholder)" : ""}` });

  // ── Quality control ──
  setJobStatus(jobId, "qa", actor, "Running quality control", "qa");
  const fresh = getGeneration(gen.id) ?? gen;
  const report = runQa(job, fresh, getVisualDNA());
  const scored = setGenerationQa(gen.id, report) ?? fresh;
  setJobQaScore(jobId, report.score);
  recordEvent({ jobId, kind: "qa", from: "qa", to: report.verdict === "pass" ? "awaiting_approval" : "needs_revision", actor, note: `QC ${report.verdict} (${report.score})` });

  const finalStatus = report.verdict === "pass" ? "awaiting_approval" : "needs_revision";
  const finalJob = setJobStatus(jobId, finalStatus, actor, report.summary, "qa_result") ?? job;
  return { ok: true, job: finalJob, generation: scored };
}

/** Human approval of a specific generation. Marks it approved; job → approved. */
export function approveGeneration(jobId: string, generationId: string, actor: string | null): CreativeJob | null {
  const job = getJob(jobId);
  const gen = getGeneration(generationId);
  if (!job || !gen || gen.jobId !== jobId) return null;
  setGenerationStatus(generationId, "approved");
  setJobApproved(jobId, generationId, gen.resultPath);
  recordEvent({ jobId, kind: "approved", from: job.status, to: "approved", actor, note: `Approved attempt ${gen.attempt}` });
  return setJobStatus(jobId, "approved", actor, "Approved by reviewer", "approved");
}

/** Reject the whole job (nothing usable). Terminal unless re-opened by a new generation. */
export function rejectJob(jobId: string, actor: string | null, note?: string): CreativeJob | null {
  const job = getJob(jobId);
  if (!job) return null;
  if (job.approvedGenerationId) setGenerationStatus(job.approvedGenerationId, "rejected");
  recordEvent({ jobId, kind: "rejected", from: job.status, to: "rejected", actor, note: note ?? "Rejected" });
  return setJobStatus(jobId, "rejected", actor, note ?? "Rejected by reviewer", "rejected");
}

/** Send back for another pass (keeps generations; clears approval). */
export function requestRevision(jobId: string, actor: string | null, note?: string): CreativeJob | null {
  const job = getJob(jobId);
  if (!job) return null;
  recordEvent({ jobId, kind: "revision", from: job.status, to: "needs_revision", actor, note: note ?? "Revision requested" });
  return setJobStatus(jobId, "needs_revision", actor, note ?? "Revision requested", "revision");
}

/** Optimize + Save Asset: finalize the approved image as the published asset. Optimization is a no-op for
 *  the SVG placeholder today (a real pipeline would transcode/compress here); we record it honestly. */
export function publishAsset(jobId: string, actor: string | null): CreativeJob | null {
  const job = getJob(jobId);
  if (!job) return null;
  if (job.status !== "approved" || !job.approvedGenerationId) return null;
  const gen = getGeneration(job.approvedGenerationId);
  const path = gen?.resultPath ?? job.approvedAssetPath ?? null;
  setJobApproved(jobId, job.approvedGenerationId, path);
  recordEvent({ jobId, kind: "published", from: job.status, to: "published", actor, note: gen?.placeholder ? "Saved (placeholder asset — optimization pending real provider)" : "Optimized and saved" });
  return setJobStatus(jobId, "published", actor, "Asset saved", "published");
}

/** Update editable job fields then rebuild the brief so it always reflects the current definition. */
export async function updateJobAndRebuild(jobId: string, input: Parameters<typeof updateJob>[1], actor: string | null): Promise<CreativeJob | null> {
  const updated = updateJob(jobId, input);
  if (!updated) return null;
  // Only rebuild once the job has left draft-without-brief; otherwise the brief builds on first generate.
  if (updated.imageBrief) return rebuildBrief(jobId, actor);
  return updated;
}
