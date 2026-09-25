// Model-agnostic image provider contract. The rest of the pipeline talks ONLY to this interface, so the
// image model can be swapped (mock ↔ fal ↔ replicate ↔ openai-image ↔ …) without touching the lifecycle,
// the Art Director, or QA. Input carries the composed Image Brief + aspect ratio + source/reference refs;
// result carries the produced image (served path) + which model made it + metadata + a placeholder flag.
//
// Pure module (no DB, no node fs) so both server orchestration and any client preview can import the shapes.

import type { ImageBrief, AspectRatio } from "../types";

/** A minimal reference to an image already in the system (source of truth / reference). */
export interface ProviderImageRef {
  id: string;
  path: string; // served URL
  filePath?: string | null; // on-disk path (server only), when the provider needs the bytes
  mime?: string | null;
}

export interface ImageGenerationInput {
  jobId: string;
  attempt: number;
  brief: ImageBrief;
  aspectRatio: AspectRatio;
  sourceImage?: ProviderImageRef | null; // reference-first edit anchor
  referenceImages?: ProviderImageRef[]; // additional style/subject references
  /** Configured model hint (e.g. an OpenAI image model id). Null = let the execution plane (n8n) choose.
   *  Free-text so new providers/models need NO schema change; the actual model used is echoed back on QA. */
  model?: string | null;
  /** Outer cap on automated attempts for this job (n8n bounds its internal revision loop to this). */
  maxAttempts?: number;
  // ── Async plumbing (populated by the service for async providers only) ──
  /** The Generation row id (async providers echo it back on the callback). */
  generationId?: string;
  /** The app's public origin (scheme + host) so a provider can build ABSOLUTE image + callback URLs. */
  baseUrl?: string;
  /** Absolute URL the provider (n8n) POSTs its result to when the workflow finishes. */
  callbackUrl?: string;
  /** Per-generation callback credential the provider must echo back for the callback to be accepted. */
  callbackToken?: string;
  /** Benchmark directive (Provider Benchmarking). When set, provider+model are PRESCRIPTIVE/authoritative:
   *  the execution plane (n8n) MUST use exactly this provider + model — it does not choose. Absent for
   *  normal (non-benchmark) generations, where `model` remains a hint and the provider chooses freely. */
  directive?: { provider: string; model: string | null; experimentId?: string; testCaseId?: string; providerRunId?: string } | null;
}

export interface ImageGenerationResult {
  ok: boolean;
  /** Raw SVG/text payload for the mock provider to persist, OR null when the provider returns a URL. */
  svg?: string | null;
  /** A remote URL a real provider returned (the orchestrator will register/fetch it). */
  url?: string | null;
  model?: string;
  placeholder: boolean; // true = NOT a real photo (mock); orchestration + QA surface this honestly
  meta?: Record<string, unknown>;
  error?: string;
  /** Async providers: true = the request was ACCEPTED and the image will arrive later via the callback.
   *  The service leaves the generation in "generating" and returns; the callback finishes it. */
  pending?: boolean;
  /** Async providers: the provider's run id (e.g. an n8n execution id) to display + correlate. */
  externalRef?: string | null;
}

/** The swappable image model. `generate` = from scratch; `edit` = reference-first (a source anchors it). */
export interface ImageGenerationProvider {
  id: string;
  label: string;
  /** true = the provider returns { pending: true } and finishes later via the callback route. Sync
   *  providers (mock/stub) omit this and complete inline as before. */
  async?: boolean;
  /** Is this provider usable right now (mock: always; key providers: key set; n8n: webhook URL set)? */
  configured(): boolean;
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
  edit(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}
