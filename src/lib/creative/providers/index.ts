// Image-provider registry + selection. The active provider is stored in the settings KV (like the other
// pluggable providers in the app), its secret key in the write-only secrets store. Selection degrades
// safely: if the chosen provider isn't configured, we fall back to the mock so the lifecycle always runs.

import { getJson, setJson } from "@/lib/kv";
import { hasSecret } from "@/lib/secrets";
import { mockProvider } from "./mock";
import { falProvider, replicateProvider, openaiImageProvider } from "./stub";
import type { ImageGenerationProvider } from "./types";
import type { CreativeProviderStatus } from "../types";

export type { ImageGenerationProvider, ImageGenerationInput, ImageGenerationResult, ProviderImageRef } from "./types";

const SELECTION_KEY = "creative_image_provider";

const REGISTRY: ImageGenerationProvider[] = [mockProvider, falProvider, replicateProvider, openaiImageProvider];

/** The secret key each provider's API key lives under (for the admin write-only form). */
export const PROVIDER_SECRET_KEYS: Record<string, string | null> = {
  mock: null,
  fal: "creative.fal.apiKey",
  replicate: "creative.replicate.apiKey",
  "openai-image": "creative.openaiImage.apiKey",
};

export function listProviders(): ImageGenerationProvider[] {
  return REGISTRY;
}

export function getProviderById(id: string): ImageGenerationProvider | undefined {
  return REGISTRY.find((p) => p.id === id);
}

/** The configured selection (defaults to mock). */
export function getSelectedProviderId(): string {
  return getJson<string>(SELECTION_KEY, "mock");
}

export function setSelectedProviderId(id: string): void {
  if (getProviderById(id)) setJson(SELECTION_KEY, id);
}

/** The provider to actually generate with: the selection if it's configured, else the mock (never fail). */
export function getActiveProvider(): ImageGenerationProvider {
  const sel = getProviderById(getSelectedProviderId());
  if (sel && sel.configured()) return sel;
  return mockProvider;
}

/** A client-safe status view of every provider (never returns key values). */
export type ProviderStatus = CreativeProviderStatus;
export function providerStatuses(): CreativeProviderStatus[] {
  const selectedId = getSelectedProviderId();
  const activeId = getActiveProvider().id;
  return REGISTRY.map((p) => {
    const secretKey = PROVIDER_SECRET_KEYS[p.id];
    return {
      id: p.id,
      label: p.label,
      configured: p.configured(),
      selected: p.id === selectedId,
      active: p.id === activeId,
      keySet: secretKey ? hasSecret(secretKey) : false,
      requiresKey: !!secretKey,
    };
  });
}
