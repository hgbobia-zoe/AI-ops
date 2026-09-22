// Image-provider registry + selection. The active provider is stored in the settings KV (like the other
// pluggable providers in the app), its secret key in the write-only secrets store. Selection degrades
// safely: if the chosen provider isn't configured, we fall back to the mock so the lifecycle always runs.

import { getJson, setJson } from "@/lib/kv";
import { hasSecret } from "@/lib/secrets";
import { mockProvider } from "./mock";
import { falProvider, replicateProvider, openaiImageProvider } from "./stub";
import { n8nProvider, getN8nWebhookUrl, hasN8nAuthToken } from "./n8n";
import type { ImageGenerationProvider } from "./types";
import type { CreativeProviderStatus } from "../types";

export type { ImageGenerationProvider, ImageGenerationInput, ImageGenerationResult, ProviderImageRef } from "./types";

const SELECTION_KEY = "creative_image_provider";

const REGISTRY: ImageGenerationProvider[] = [mockProvider, n8nProvider, falProvider, replicateProvider, openaiImageProvider];

/** The secret key each provider's API key lives under (for the admin write-only form). n8n's key config is
 *  richer (webhook URL + auth token) and handled specially, so it has no single "apiKey" here. */
export const PROVIDER_SECRET_KEYS: Record<string, string | null> = {
  mock: null,
  n8n: null,
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
    const base: CreativeProviderStatus = {
      id: p.id,
      label: p.label,
      configured: p.configured(),
      selected: p.id === selectedId,
      active: p.id === activeId,
      keySet: secretKey ? hasSecret(secretKey) : false,
      requiresKey: !!secretKey,
      kind: p.id === "n8n" ? "n8n" : "key",
    };
    if (p.id === "n8n") {
      base.webhookUrl = getN8nWebhookUrl();
      base.authTokenSet = hasN8nAuthToken();
    }
    return base;
  });
}
