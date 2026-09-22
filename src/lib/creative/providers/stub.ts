// Stubbed real image-model adapters (fal / replicate / openai-image). These are the swap-in slots for a
// production model. Each is "configured" only when its API key is present (secrets store or env), matching
// the app's write-only-secret provider pattern. Until the HTTP call is actually wired, generate/edit return
// an honest, explicit error rather than a fabricated image — so a half-configured provider fails loudly
// instead of silently faking a Zoe photo. To go live: implement the fetch to the model's endpoint inside
// `callModel`, returning { url } of the produced image. Everything downstream already handles a URL result.

import { getSecret } from "@/lib/secrets";
import type { ImageGenerationInput, ImageGenerationProvider, ImageGenerationResult } from "./types";

function makeStub(cfg: { id: string; label: string; secretKey: string; envKey: string }): ImageGenerationProvider {
  const keyPresent = (): boolean => !!(getSecret(cfg.secretKey) || process.env[cfg.envKey]);
  // The real HTTP call to the model would consume `input` (brief, aspect ratio, source/reference images)
  // and return { url } of the produced image. Until wired, it fails loudly instead of faking a photo.
  const notWired = async (input: ImageGenerationInput): Promise<ImageGenerationResult> => ({
    ok: false,
    placeholder: false,
    error:
      `${cfg.label} adapter is stubbed: the API key is set but the HTTP call is not wired yet ` +
      `(job ${input.jobId}, attempt ${input.attempt}). Implement callModel() in providers/stub.ts, or ` +
      `switch the active provider to "mock" to run the lifecycle with placeholders.`,
  });
  return {
    id: cfg.id,
    label: cfg.label,
    configured: keyPresent,
    // Both entry points hit the same stub today; a real impl would branch generate vs edit (img2img)
    // using the input (brief + aspect ratio + source/reference refs).
    generate: (input: ImageGenerationInput) => notWired(input),
    edit: (input: ImageGenerationInput) => notWired(input),
  };
}

export const falProvider = makeStub({ id: "fal", label: "fal.ai", secretKey: "creative.fal.apiKey", envKey: "FAL_API_KEY" });
export const replicateProvider = makeStub({ id: "replicate", label: "Replicate", secretKey: "creative.replicate.apiKey", envKey: "REPLICATE_API_TOKEN" });
export const openaiImageProvider = makeStub({ id: "openai-image", label: "OpenAI Images", secretKey: "creative.openaiImage.apiKey", envKey: "OPENAI_API_KEY" });
