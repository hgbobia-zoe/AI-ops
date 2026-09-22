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
}

/** The swappable image model. `generate` = from scratch; `edit` = reference-first (a source anchors it). */
export interface ImageGenerationProvider {
  id: string;
  label: string;
  /** Is this provider usable right now (mock: always; real: only when its API key secret is set)? */
  configured(): boolean;
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
  edit(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}
