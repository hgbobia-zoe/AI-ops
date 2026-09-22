// Creative Engine — persistence layer. Server-only (imports getDb). Deterministic writes; no fabrication.
// The job row owns the lifecycle; generations record each attempt with its frozen brief + QA report;
// creative_images holds the pixels (uploaded / existing / generated); creative_events is the attributed
// audit. Everything the client sees comes back through the pure shapes in types.ts.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/index";
import {
  type CreativeJob,
  type CreativeJobInput,
  type JobStatus,
  type AssetType,
  type SourceMode,
  type AspectRatio,
  type ImageBrief,
  type Generation,
  type GenerationStatus,
  type QaReport,
  type CreativeImage,
  type ImageKind,
  type CreativeEvent,
  isAssetType,
  isSourceMode,
  isAspectRatio,
  defaultPreserve,
  defaultTransform,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const now = (): string => new Date().toISOString();
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const nullableStr = (v: unknown): string | null => {
  const s = str(v);
  return s ? s : null;
};
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
const cleanList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x.length > 0) : [];

// ── Jobs ──────────────────────────────────────────────────────────────────────────────────────────
function toJob(r: any): CreativeJob {
  return {
    id: String(r.id),
    title: r.title,
    campaign: r.campaign ?? null,
    page: r.page ?? null,
    section: r.section ?? null,
    assetType: r.asset_type as AssetType,
    product: r.product ?? null,
    productCategory: r.product_category ?? null,
    sourceMode: r.source_mode as SourceMode,
    sourceImageId: r.source_image_id ?? null,
    referenceImageIds: parseArr(r.reference_image_ids),
    aspectRatio: r.aspect_ratio as AspectRatio,
    targetAudience: r.target_audience ?? null,
    objective: r.objective ?? null,
    season: r.season ?? null,
    locationContext: r.location_context ?? null,
    visualDirection: r.visual_direction ?? null,
    preserve: parseArr(r.preserve),
    transform: parseArr(r.transform),
    status: r.status as JobStatus,
    selectedModel: r.selected_model ?? null,
    generationCount: Number(r.generation_count ?? 0),
    qaScore: r.qa_score == null ? null : Number(r.qa_score),
    imageBrief: parseJson<ImageBrief>(r.image_brief),
    approvedGenerationId: r.approved_generation_id ?? null,
    approvedAssetPath: r.approved_asset_path ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getJob(id: string): CreativeJob | null {
  const r = getDb().prepare("SELECT * FROM creative_jobs WHERE id = ?").get(id);
  return r ? toJob(r) : null;
}

export function listJobs(): CreativeJob[] {
  return (getDb().prepare("SELECT * FROM creative_jobs ORDER BY updated_at DESC").all() as any[]).map(toJob);
}

/** Create a job from validated input. Defaults preserve/transform per source-mode + asset-type when the
 *  caller didn't supply them. Records a 'created' event. Status starts at 'draft'. */
export function createJob(input: CreativeJobInput, actor: string | null): CreativeJob {
  const assetType: AssetType = isAssetType(input.assetType) ? input.assetType : "lifestyle";
  const sourceMode: SourceMode = isSourceMode(input.sourceMode) ? input.sourceMode : "scratch";
  const aspectRatio: AspectRatio = isAspectRatio(input.aspectRatio) ? input.aspectRatio : "3:2";
  const preserve = input.preserve && input.preserve.length ? cleanList(input.preserve) : defaultPreserve(sourceMode, assetType);
  const transform = input.transform && input.transform.length ? cleanList(input.transform) : defaultTransform(assetType);
  const id = `CJ-${randomUUID()}`;
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO creative_jobs (id, title, campaign, page, section, asset_type, product, product_category,
         source_mode, source_image_id, reference_image_ids, aspect_ratio, target_audience, objective, season,
         location_context, visual_direction, preserve, transform, status, selected_model, generation_count,
         qa_score, image_brief, approved_generation_id, approved_asset_path, created_by, created_at, updated_at)
       VALUES (@id,@title,@campaign,@page,@section,@assetType,@product,@productCategory,@sourceMode,@sourceImageId,
         @referenceImageIds,@aspectRatio,@targetAudience,@objective,@season,@locationContext,@visualDirection,
         @preserve,@transform,'draft',NULL,0,NULL,NULL,NULL,NULL,@createdBy,@ts,@ts)`,
    )
    .run({
      id,
      title: str(input.title) || "Untitled asset",
      campaign: nullableStr(input.campaign),
      page: nullableStr(input.page),
      section: nullableStr(input.section),
      assetType,
      product: nullableStr(input.product),
      productCategory: nullableStr(input.productCategory),
      sourceMode,
      sourceImageId: nullableStr(input.sourceImageId),
      referenceImageIds: JSON.stringify(cleanList(input.referenceImageIds)),
      aspectRatio,
      targetAudience: nullableStr(input.targetAudience),
      objective: nullableStr(input.objective),
      season: nullableStr(input.season),
      locationContext: nullableStr(input.locationContext),
      visualDirection: nullableStr(input.visualDirection),
      preserve: JSON.stringify(preserve),
      transform: JSON.stringify(transform),
      createdBy: actor,
      ts,
    });
  recordEvent({ jobId: id, kind: "created", from: null, to: "draft", actor, note: "Creative job created" });
  return getJob(id)!;
}

/** Patch editable fields on a job. Only provided keys change. */
export function updateJob(id: string, input: CreativeJobInput): CreativeJob | null {
  const prev = getJob(id);
  if (!prev) return null;
  const next = {
    title: input.title !== undefined ? str(input.title) || prev.title : prev.title,
    campaign: input.campaign !== undefined ? nullableStr(input.campaign) : prev.campaign,
    page: input.page !== undefined ? nullableStr(input.page) : prev.page,
    section: input.section !== undefined ? nullableStr(input.section) : prev.section,
    assetType: isAssetType(input.assetType) ? input.assetType : prev.assetType,
    product: input.product !== undefined ? nullableStr(input.product) : prev.product,
    productCategory: input.productCategory !== undefined ? nullableStr(input.productCategory) : prev.productCategory,
    sourceMode: isSourceMode(input.sourceMode) ? input.sourceMode : prev.sourceMode,
    sourceImageId: input.sourceImageId !== undefined ? nullableStr(input.sourceImageId) : prev.sourceImageId,
    referenceImageIds: input.referenceImageIds !== undefined ? cleanList(input.referenceImageIds) : prev.referenceImageIds,
    aspectRatio: isAspectRatio(input.aspectRatio) ? input.aspectRatio : prev.aspectRatio,
    targetAudience: input.targetAudience !== undefined ? nullableStr(input.targetAudience) : prev.targetAudience,
    objective: input.objective !== undefined ? nullableStr(input.objective) : prev.objective,
    season: input.season !== undefined ? nullableStr(input.season) : prev.season,
    locationContext: input.locationContext !== undefined ? nullableStr(input.locationContext) : prev.locationContext,
    visualDirection: input.visualDirection !== undefined ? nullableStr(input.visualDirection) : prev.visualDirection,
    preserve: input.preserve !== undefined ? cleanList(input.preserve) : prev.preserve,
    transform: input.transform !== undefined ? cleanList(input.transform) : prev.transform,
  };
  getDb()
    .prepare(
      `UPDATE creative_jobs SET title=@title, campaign=@campaign, page=@page, section=@section, asset_type=@assetType,
         product=@product, product_category=@productCategory, source_mode=@sourceMode, source_image_id=@sourceImageId,
         reference_image_ids=@referenceImageIds, aspect_ratio=@aspectRatio, target_audience=@targetAudience,
         objective=@objective, season=@season, location_context=@locationContext, visual_direction=@visualDirection,
         preserve=@preserve, transform=@transform, updated_at=@ts WHERE id=@id`,
    )
    .run({
      id,
      ...next,
      referenceImageIds: JSON.stringify(next.referenceImageIds),
      preserve: JSON.stringify(next.preserve),
      transform: JSON.stringify(next.transform),
      ts: now(),
    });
  return getJob(id);
}

/** Move a job to a new status. Records an attributed event unless silent. No-op if unchanged. */
export function setJobStatus(id: string, to: JobStatus, actor: string | null, note?: string, kind?: string): CreativeJob | null {
  const prev = getJob(id);
  if (!prev) return null;
  if (prev.status === to) return prev;
  getDb().prepare("UPDATE creative_jobs SET status=@to, updated_at=@ts WHERE id=@id").run({ to, ts: now(), id });
  recordEvent({ jobId: id, kind: kind ?? "status", from: prev.status, to, actor: actor ?? null, note: note ?? null });
  return getJob(id);
}

/** Store the Art Director's brief on the job (and move draft → queued). */
export function setJobBrief(id: string, brief: ImageBrief, actor: string | null): CreativeJob | null {
  const prev = getJob(id);
  if (!prev) return null;
  getDb().prepare("UPDATE creative_jobs SET image_brief=@brief, updated_at=@ts WHERE id=@id").run({ brief: JSON.stringify(brief), ts: now(), id });
  recordEvent({ jobId: id, kind: "brief_built", from: prev.status, to: prev.status, actor: actor ?? null, note: `Image brief assembled (${brief.briefSource})` });
  if (prev.status === "draft") return setJobStatus(id, "queued", actor, "Art direction ready", "art_direction");
  return getJob(id);
}

export function setJobQaScore(id: string, score: number | null): void {
  getDb().prepare("UPDATE creative_jobs SET qa_score=@score, updated_at=@ts WHERE id=@id").run({ score, ts: now(), id });
}

export function setJobApproved(id: string, generationId: string, assetPath: string | null): void {
  getDb()
    .prepare("UPDATE creative_jobs SET approved_generation_id=@gid, approved_asset_path=@path, updated_at=@ts WHERE id=@id")
    .run({ gid: generationId, path: assetPath, ts: now(), id });
}

export function setJobModel(id: string, model: string | null): void {
  getDb().prepare("UPDATE creative_jobs SET selected_model=@model, updated_at=@ts WHERE id=@id").run({ model, ts: now(), id });
}

// ── Generations ─────────────────────────────────────────────────────────────────────────────────────
function toGeneration(r: any): Generation {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    attempt: Number(r.attempt),
    provider: r.provider,
    model: r.model ?? null,
    briefSnapshot: parseJson<ImageBrief>(r.brief_snapshot),
    imageId: r.image_id ?? null,
    resultPath: r.result_path ?? null,
    placeholder: !!r.placeholder,
    resultMeta: parseJson<Record<string, unknown>>(r.result_meta),
    qaScore: r.qa_score == null ? null : Number(r.qa_score),
    qaReport: parseJson<QaReport>(r.qa_report),
    status: r.status as GenerationStatus,
    externalRef: r.external_ref ?? null,
    createdAt: r.created_at,
  };
}

export function listGenerations(jobId: string): Generation[] {
  return (getDb().prepare("SELECT * FROM creative_generations WHERE job_id = ? ORDER BY attempt DESC").all(jobId) as any[]).map(toGeneration);
}

export function getGeneration(id: string): Generation | null {
  const r = getDb().prepare("SELECT * FROM creative_generations WHERE id = ?").get(id);
  return r ? toGeneration(r) : null;
}

export function nextAttempt(jobId: string): number {
  const row = getDb().prepare("SELECT MAX(attempt) AS m FROM creative_generations WHERE job_id = ?").get(jobId) as { m: number | null };
  return (row?.m ?? 0) + 1;
}

export function insertGeneration(g: {
  jobId: string;
  attempt: number;
  provider: string;
  model: string | null;
  brief: ImageBrief;
  imageId: string | null;
  resultPath: string | null;
  placeholder: boolean;
  resultMeta: Record<string, unknown> | null;
  status: GenerationStatus;
  callbackToken?: string | null; // async providers only
  externalRef?: string | null;
}): Generation {
  const id = `CG-${randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO creative_generations (id, job_id, attempt, provider, model, brief_snapshot, image_id, result_path,
         placeholder, result_meta, qa_score, qa_report, status, callback_token, external_ref, created_at)
       VALUES (@id,@jobId,@attempt,@provider,@model,@brief,@imageId,@resultPath,@placeholder,@resultMeta,NULL,NULL,@status,@callbackToken,@externalRef,@ts)`,
    )
    .run({
      id,
      jobId: g.jobId,
      attempt: g.attempt,
      provider: g.provider,
      model: g.model,
      brief: JSON.stringify(g.brief),
      imageId: g.imageId,
      resultPath: g.resultPath,
      placeholder: g.placeholder ? 1 : 0,
      resultMeta: g.resultMeta ? JSON.stringify(g.resultMeta) : null,
      status: g.status,
      callbackToken: g.callbackToken ?? null,
      externalRef: g.externalRef ?? null,
      ts: now(),
    });
  getDb().prepare("UPDATE creative_jobs SET generation_count = generation_count + 1, updated_at=@ts WHERE id=@jobId").run({ ts: now(), jobId: g.jobId });
  return getGeneration(id)!;
}

/** Server-only: the async callback credential stored on a generation (never exposed to the client). */
export function getGenerationCallbackToken(id: string): string | null {
  const r = getDb().prepare("SELECT callback_token FROM creative_generations WHERE id = ?").get(id) as { callback_token: string | null } | undefined;
  return r?.callback_token ?? null;
}

export function setGenerationExternalRef(id: string, externalRef: string | null): void {
  getDb().prepare("UPDATE creative_generations SET external_ref=@externalRef WHERE id=@id").run({ externalRef, id });
}

export function setGenerationCallbackToken(id: string, token: string): void {
  getDb().prepare("UPDATE creative_generations SET callback_token=@token WHERE id=@id").run({ token, id });
}

/** Apply an async result's image (from the callback) to a pending generation. QA is set separately. */
export function setGenerationResult(id: string, r: { imageId: string | null; resultPath: string | null; model: string | null; placeholder: boolean; meta: Record<string, unknown> | null }): void {
  getDb()
    .prepare("UPDATE creative_generations SET image_id=@imageId, result_path=@resultPath, model=@model, placeholder=@placeholder, result_meta=@meta WHERE id=@id")
    .run({ imageId: r.imageId, resultPath: r.resultPath, model: r.model, placeholder: r.placeholder ? 1 : 0, meta: r.meta ? JSON.stringify(r.meta) : null, id });
}

export function setGenerationQa(id: string, report: QaReport): Generation | null {
  getDb()
    .prepare("UPDATE creative_generations SET qa_score=@score, qa_report=@report, status=@status WHERE id=@id")
    .run({ score: report.score, report: JSON.stringify(report), status: report.verdict === "pass" ? "pass" : "fail", id });
  return getGeneration(id);
}

export function setGenerationStatus(id: string, status: GenerationStatus): void {
  getDb().prepare("UPDATE creative_generations SET status=@status WHERE id=@id").run({ status, id });
}

// ── Images ──────────────────────────────────────────────────────────────────────────────────────────
function toImage(r: any): CreativeImage {
  return {
    id: String(r.id),
    kind: r.kind as ImageKind,
    name: r.name ?? null,
    path: r.path,
    mime: r.mime ?? null,
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    placeholder: !!r.placeholder,
    jobId: r.job_id ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  };
}

export function getImage(id: string): CreativeImage | null {
  const r = getDb().prepare("SELECT * FROM creative_images WHERE id = ?").get(id);
  return r ? toImage(r) : null;
}

/** Server-only: the on-disk path for serving (never exposed in the client shape). */
export function getImageFilePath(id: string): { filePath: string | null; mime: string | null } | null {
  const r = getDb().prepare("SELECT file_path, mime FROM creative_images WHERE id = ?").get(id) as { file_path: string | null; mime: string | null } | undefined;
  return r ? { filePath: r.file_path ?? null, mime: r.mime ?? null } : null;
}

export function listImages(kind?: ImageKind): CreativeImage[] {
  const rows = kind
    ? (getDb().prepare("SELECT * FROM creative_images WHERE kind = ? ORDER BY created_at DESC").all(kind) as any[])
    : (getDb().prepare("SELECT * FROM creative_images ORDER BY created_at DESC").all() as any[]);
  return rows.map(toImage);
}

/** Images pickable as a source of truth (uploads + prior generated approved assets treated as library). */
export function listSelectableImages(): CreativeImage[] {
  return (getDb().prepare("SELECT * FROM creative_images WHERE kind IN ('upload','existing') ORDER BY created_at DESC").all() as any[]).map(toImage);
}

export function insertImage(img: {
  kind: ImageKind;
  name: string | null;
  servedPath: string; // provisional; path is set to /api/creative/image/<id> after id is known
  filePath: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  placeholder: boolean;
  jobId: string | null;
  createdBy: string | null;
}): CreativeImage {
  const id = `CI-${randomUUID()}`;
  const served = `/api/creative/image/${id}`;
  getDb()
    .prepare(
      `INSERT INTO creative_images (id, kind, name, path, file_path, mime, width, height, placeholder, job_id, created_by, created_at)
       VALUES (@id,@kind,@name,@path,@filePath,@mime,@width,@height,@placeholder,@jobId,@createdBy,@ts)`,
    )
    .run({
      id,
      kind: img.kind,
      name: img.name,
      path: served,
      filePath: img.filePath,
      mime: img.mime,
      width: img.width,
      height: img.height,
      placeholder: img.placeholder ? 1 : 0,
      jobId: img.jobId,
      createdBy: img.createdBy,
      ts: now(),
    });
  return getImage(id)!;
}

// ── Events (attributed audit) ───────────────────────────────────────────────────────────────────────
function toEvent(r: any): CreativeEvent {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    kind: r.kind,
    fromStatus: (r.from_status as JobStatus) ?? null,
    toStatus: (r.to_status as JobStatus) ?? null,
    actor: r.actor ?? null,
    note: r.note ?? null,
    ts: r.ts,
  };
}

export interface EventInput {
  jobId: string;
  kind: string;
  from?: JobStatus | null;
  to?: JobStatus | null;
  actor: string | null;
  note?: string | null;
}
export function recordEvent(e: EventInput): void {
  getDb()
    .prepare(
      `INSERT INTO creative_events (id, job_id, kind, from_status, to_status, actor, note, ts)
       VALUES (@id,@jobId,@kind,@from,@to,@actor,@note,@ts)`,
    )
    .run({ id: `CE-${randomUUID()}`, jobId: e.jobId, kind: e.kind, from: e.from ?? null, to: e.to ?? null, actor: e.actor, note: e.note ?? null, ts: now() });
}

export function listEvents(jobId: string): CreativeEvent[] {
  return (getDb().prepare("SELECT * FROM creative_events WHERE job_id = ? ORDER BY ts").all(jobId) as any[]).map(toEvent);
}

/* eslint-enable @typescript-eslint/no-explicit-any */
