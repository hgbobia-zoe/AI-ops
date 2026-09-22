// Creative Engine — lifecycle orchestration (server-only). Ties the Art Director, the model-agnostic
// provider, image persistence, and deterministic QA into the state machine:
//   Define → Art Direction → Generate → QC → Pass/Fail → (Regenerate) → Human Review → Approve → Save.
// Every state change is attributed (currentActor label passed in) and audited. Placeholders are always
// disclosed. Nothing here fabricates: QA scores are real fractions, and a generation only exists once the
// provider returns an image.

import { randomUUID, timingSafeEqual } from "node:crypto";
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
  setGenerationResult,
  setGenerationExternalRef,
  setGenerationCallbackToken,
  getGenerationCallbackToken,
  getGeneration,
  insertImage,
  getImage,
  nextAttempt,
  recordEvent,
} from "./store";
import { buildBrief } from "./artDirector";
import { runQa, n8nQaReport, type N8nQaInput } from "./qa";
import { getVisualDNA } from "./visualDna";
import { getActiveProvider } from "./providers";
import { mintCallbackToken } from "./providers/n8n";
import type { ImageGenerationInput, ImageGenerationResult, ProviderImageRef } from "./providers/types";
import { isReferenceFirst, type CreativeJob, type Generation, type ImageBrief } from "./types";

/** System actor label for the n8n callback (an async, non-human transition). */
export const N8N_ACTOR = "n8n";

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
  pending?: boolean; // async provider accepted the job; the callback will finish it
  job?: CreativeJob;
  generation?: Generation;
}

/** Run one generation attempt: art-direct (if needed) → provider → persist → QA → advance status. When the
 *  active provider is ASYNC (n8n), the attempt is handed off and left pending; the callback finishes it.
 *  `origin` is the app's public base URL (for absolute image + callback URLs); required for async providers. */
export async function generateForJob(jobId: string, actor: string | null, opts: { origin?: string } = {}): Promise<GenerateOutcome> {
  const withBrief = await ensureBrief(jobId, actor);
  if (!withBrief) return { ok: false, error: "job_not_found" };
  const job = withBrief;
  const brief = job.imageBrief as ImageBrief;

  const provider = getActiveProvider();
  const attempt = nextAttempt(jobId);
  const useEdit = isReferenceFirst(job.sourceMode) && !!job.sourceImageId;

  // ── Async provider (n8n): create the pending record + mint a callback token, hand off, and return. ──
  if (provider.async) {
    const gen = insertGeneration({
      jobId,
      attempt,
      provider: provider.id,
      model: null,
      brief,
      imageId: null,
      resultPath: null,
      placeholder: false,
      resultMeta: { mode: useEdit ? "edit" : "generate" },
      status: "generating",
      callbackToken: null, // set below once we have the row id (token derives from it)
    });
    const token = mintCallbackToken(gen.id);
    // Persist the minted token so the callback can constant-time-compare it.
    setGenerationCallbackToken(gen.id, token);
    setJobStatus(jobId, "generating", actor, `Handed to ${provider.label}`, "generate");

    const origin = (opts.origin || "").replace(/\/+$/, "");
    const input: ImageGenerationInput = {
      jobId,
      attempt,
      generationId: gen.id,
      brief,
      aspectRatio: job.aspectRatio,
      sourceImage: toRef(job.sourceImageId),
      referenceImages: job.referenceImageIds.map(toRef).filter((r): r is ProviderImageRef => r !== null),
      baseUrl: origin,
      callbackUrl: origin ? `${origin}/api/creative/callback` : "/api/creative/callback",
      callbackToken: token,
    };

    let result: ImageGenerationResult;
    try {
      result = useEdit ? await provider.edit(input) : await provider.generate(input);
    } catch (e) {
      result = { ok: false, placeholder: false, error: String(e) };
    }

    if (!result.ok) {
      setGenerationStatus(gen.id, "error");
      recordEvent({ jobId, kind: "handoff_failed", from: "generating", to: "needs_revision", actor, note: result.error ?? "n8n handoff failed" });
      const parked = setJobStatus(jobId, "needs_revision", actor, result.error ?? "n8n handoff failed", "handoff_failed") ?? undefined;
      return { ok: false, error: result.error ?? "handoff_failed", job: parked, generation: getGeneration(gen.id) ?? gen };
    }
    if (result.externalRef) setGenerationExternalRef(gen.id, result.externalRef);
    recordEvent({ jobId, kind: "handed_off", from: "generating", to: "generating", actor, note: `Attempt ${attempt} handed to ${provider.label}${result.externalRef ? ` (run ${result.externalRef})` : ""}; awaiting callback` });
    return { ok: true, pending: true, job: getJob(jobId) ?? job, generation: getGeneration(gen.id) ?? gen };
  }

  // ── Synchronous providers (mock / stubbed real models): complete inline as before. ──
  setJobStatus(jobId, "generating", actor, `Generating with ${provider.label}`, "generate");

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

// ── Async callback completion (n8n) ──────────────────────────────────────────────────────────────────
const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};

/** Persist an image the workflow produced — either a URL we download, or an inline base64 payload. Returns
 *  the served creative_images row info, or null if nothing usable was provided. */
async function persistExternalImage(job: CreativeJob, opts: { imageUrl?: string | null; imageBase64?: string | null; mime?: string | null }): Promise<{ imageId: string; path: string } | null> {
  let bytes: Buffer | null = null;
  let mime = (opts.mime || "").toLowerCase() || null;

  if (opts.imageBase64) {
    const m = /^data:([^;]+);base64,(.*)$/i.exec(opts.imageBase64.trim());
    if (m) {
      mime = mime || m[1].toLowerCase();
      bytes = Buffer.from(m[2], "base64");
    } else {
      bytes = Buffer.from(opts.imageBase64.trim(), "base64");
    }
  } else if (opts.imageUrl) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(opts.imageUrl, { signal: ctrl.signal });
      if (!res.ok) return null;
      mime = mime || (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() || null;
      bytes = Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
  if (!bytes || bytes.length === 0) return null;

  await mkdir(GEN_DIR, { recursive: true });
  const ext = (mime && MIME_EXT[mime]) || ".png";
  const filePath = join(GEN_DIR, `${randomUUID()}${ext}`);
  await writeFile(filePath, bytes);
  const img = insertImage({
    kind: "generated",
    name: `${job.title} — n8n result`,
    servedPath: "",
    filePath,
    mime: mime || "image/png",
    width: null,
    height: null,
    placeholder: false,
    jobId: job.id,
    createdBy: N8N_ACTOR,
  });
  return { imageId: img.id, path: img.path };
}

export interface CallbackPayload {
  status: "succeeded" | "failed";
  imageUrl?: string | null;
  imageBase64?: string | null;
  mime?: string | null;
  model?: string | null;
  modelChain?: string[] | null;
  qa?: N8nQaInput | null;
  error?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface CallbackOutcome {
  ok: boolean;
  already?: boolean;
  error?: string;
  job?: CreativeJob;
  generation?: Generation;
}

/** Finish a pending async generation from the n8n callback. n8n's QA is primary; we add only the light
 *  reference-first constraint check. Human approval still gates publishing. Attributed to the n8n actor. */
export async function completeAsyncGeneration(generationId: string, payload: CallbackPayload): Promise<CallbackOutcome> {
  const gen = getGeneration(generationId);
  if (!gen) return { ok: false, error: "generation_not_found" };
  const job = getJob(gen.jobId);
  if (!job) return { ok: false, error: "job_not_found" };
  // Idempotent: only a still-pending generation can be finished by a callback.
  if (gen.status !== "generating") return { ok: true, already: true, job, generation: gen };

  if (payload.status !== "succeeded") {
    setGenerationStatus(generationId, "error");
    recordEvent({ jobId: job.id, kind: "n8n_failed", from: "generating", to: "needs_revision", actor: N8N_ACTOR, note: payload.error || "n8n reported failure" });
    const parked = setJobStatus(job.id, "needs_revision", N8N_ACTOR, payload.error || "n8n reported failure", "n8n_failed") ?? job;
    return { ok: true, job: parked, generation: getGeneration(generationId) ?? gen };
  }

  const persisted = await persistExternalImage(job, { imageUrl: payload.imageUrl, imageBase64: payload.imageBase64, mime: payload.mime });
  if (!persisted) {
    setGenerationStatus(generationId, "error");
    recordEvent({ jobId: job.id, kind: "n8n_no_image", from: "generating", to: "needs_revision", actor: N8N_ACTOR, note: "Callback succeeded but no usable image was provided" });
    const parked = setJobStatus(job.id, "needs_revision", N8N_ACTOR, "Callback had no usable image", "n8n_no_image") ?? job;
    return { ok: false, error: "no_image", job: parked, generation: getGeneration(generationId) ?? gen };
  }

  const model = (payload.modelChain && payload.modelChain.length ? payload.modelChain.join(" → ") : payload.model) || null;
  setGenerationResult(generationId, {
    imageId: persisted.imageId,
    resultPath: persisted.path,
    model,
    placeholder: false,
    meta: { ...(payload.meta ?? {}), source: "n8n", modelChain: payload.modelChain ?? undefined },
  });
  if (model && !job.selectedModel) setJobModel(job.id, model);

  const report = n8nQaReport(job, payload.qa ?? null, true);
  setGenerationQa(generationId, report);
  setJobQaScore(job.id, report.score);
  recordEvent({ jobId: job.id, kind: "n8n_result", from: "generating", to: report.verdict === "pass" ? "awaiting_approval" : "needs_revision", actor: N8N_ACTOR, note: `n8n QA ${report.verdict} (${report.score})${model ? ` · ${model}` : ""}` });

  const finalStatus = report.verdict === "pass" ? "awaiting_approval" : "needs_revision";
  const finalJob = setJobStatus(job.id, finalStatus, N8N_ACTOR, report.summary, "n8n_result") ?? job;
  return { ok: true, job: finalJob, generation: getGeneration(generationId) ?? gen };
}

/** Server-only: constant-time check that a presented token matches the generation's stored callback token. */
export function verifyCallbackToken(generationId: string, presented: string): boolean {
  const stored = getGenerationCallbackToken(generationId);
  if (!stored || !presented) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
