// n8n workflow image provider — ASYNC. Instead of calling one model, we hand the composed Image Brief to
// an n8n webhook that daisy-chains multiple models with its own QA in the middle, then n8n POSTs the final
// result back to our callback route. Decisions baked in: (A) async callback return; (B) n8n picks the
// models and runs generation-QA, while the app keeps HUMAN APPROVAL and layers only a light reference-first
// constraint check.
//
// Config:
//   • webhook URL — a normal setting (KV: creative.n8n.webhookUrl), editable in the Visual DNA UI.
//   • auth token  — a WRITE-ONLY secret (creative.n8n.authToken); sent as `Authorization: Bearer <token>`.
//   • callback shared secret (creative.n8n.callbackSecret) — auto-minted; used to derive the per-generation
//     callback token the workflow must echo back.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { getJson, setJson } from "@/lib/kv";
import { getSecret, setSecret, hasSecret } from "@/lib/secrets";
import { signImagePath } from "../assetUrl";
import type { ImageGenerationInput, ImageGenerationProvider, ImageGenerationResult, ProviderImageRef } from "./types";

export const N8N_WEBHOOK_KEY = "creative.n8n.webhookUrl";
export const N8N_TOKEN_SECRET = "creative.n8n.authToken";
export const N8N_CALLBACK_SECRET = "creative.n8n.callbackSecret";

export function getN8nWebhookUrl(): string | null {
  const v = getJson<string>(N8N_WEBHOOK_KEY, "").trim();
  return v ? v : null;
}
export function setN8nWebhookUrl(url: string): void {
  setJson(N8N_WEBHOOK_KEY, (url || "").trim());
}
export function hasN8nAuthToken(): boolean {
  return hasSecret(N8N_TOKEN_SECRET);
}

/** The shared secret used to mint per-generation callback tokens. Auto-created on first use. */
function callbackSecret(): string {
  let s = getSecret(N8N_CALLBACK_SECRET);
  if (!s) {
    s = randomBytes(32).toString("hex");
    setSecret(N8N_CALLBACK_SECRET, s);
  }
  return s;
}

/** Mint a per-generation callback token: HMAC(sharedSecret, generationId:nonce). Unguessable; the app
 *  stores it on the generation row and constant-time-compares the value the callback presents. */
export function mintCallbackToken(generationId: string): string {
  return createHmac("sha256", callbackSecret()).update(`${generationId}:${randomUUID()}`).digest("hex");
}

/** Build an absolute, SIGNED, short-lived URL for an image ref the workflow will fetch (n8n runs off-box and
 *  carries no session). The signature lets the proxy admit this one fetch without exposing every image
 *  publicly. Already-absolute (external) paths pass through untouched. */
async function signedAbsUrl(baseUrl: string | undefined, ref: ProviderImageRef | null | undefined): Promise<string | null> {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref.path)) return ref.path;
  const signed = await signImagePath(ref.id); // /api/creative/image/<id>?exp=&sig=
  if (!baseUrl) return signed; // best effort in dev; the gate is off when there's no signing key anyway
  return `${baseUrl.replace(/\/+$/, "")}${signed.startsWith("/") ? "" : "/"}${signed}`;
}

async function handOff(input: ImageGenerationInput, mode: "generate" | "edit"): Promise<ImageGenerationResult> {
  const webhookUrl = getN8nWebhookUrl();
  if (!webhookUrl) return { ok: false, placeholder: false, error: "n8n webhook URL is not set" };
  if (!input.callbackUrl || !input.callbackToken || !input.generationId) {
    return { ok: false, placeholder: false, error: "async plumbing missing (callbackUrl/token/generationId)" };
  }

  const sourceUrl = input.sourceImage ? await signedAbsUrl(input.baseUrl, input.sourceImage) : null;
  const referenceUrls = (
    await Promise.all((input.referenceImages ?? []).map((r) => signedAbsUrl(input.baseUrl, r)))
  ).filter((u): u is string => !!u);

  // Benchmark directive: during a Provider Benchmark, provider+model are PRESCRIPTIVE — the request carries
  // the specific provider/model the workflow MUST use (not the generic "n8n"/hint). Absent for normal jobs.
  const directive = input.directive ?? null;
  const body = {
    generationId: input.generationId,
    jobId: input.jobId,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts ?? null, // bound n8n's internal revision loop to Tower's cap
    provider: directive?.provider ?? "n8n",
    // Configured model hint; null = n8n chooses. During a benchmark this is AUTHORITATIVE (directive).
    model: directive?.model ?? input.model ?? null,
    callbackUrl: input.callbackUrl,
    callbackToken: input.callbackToken,
    brief: input.brief,
    aspectRatio: input.aspectRatio,
    // PRESERVE = source of truth (must survive) · TRANSFORM = creative latitude. Explicit at top level so the
    // workflow can gate on them without parsing the brief.
    preserve: input.brief.preserve,
    transform: input.brief.transform,
    source: sourceUrl ? { url: sourceUrl } : null,
    references: referenceUrls.map((url) => ({ url })),
    meta: {
      mode,
      briefSource: input.brief.briefSource,
      dnaVersion: input.brief.dnaVersion ?? null,
      // When present, the workflow MUST treat provider+model as prescriptive (see n8n contract §11).
      ...(directive ? { benchmark: { provider: directive.provider, model: directive.model, prescriptive: true, experimentId: directive.experimentId ?? null, testCaseId: directive.testCaseId ?? null, providerRunId: directive.providerRunId ?? null } } : {}),
    },
  };

  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getSecret(N8N_TOKEN_SECRET);
  if (token) headers.authorization = `Bearer ${token}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(webhookUrl, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text().catch(() => "");
      return { ok: false, placeholder: false, error: `n8n webhook ${res.status}: ${text.slice(0, 200)}`.trim() };
    }
    // Optionally read an n8n run id from the response (executionId / runId / id). Non-fatal if absent.
    let externalRef: string | null = null;
    try {
      const data = (await res.json()) as { executionId?: string; runId?: string; id?: string } | null;
      externalRef = data?.executionId || data?.runId || data?.id || null;
    } catch {
      /* n8n "Respond Immediately" may return no JSON — fine */
    }
    return { ok: true, placeholder: false, pending: true, externalRef, meta: { mode } };
  } catch (e) {
    return { ok: false, placeholder: false, error: `n8n webhook error: ${String(e)}` };
  } finally {
    clearTimeout(t);
  }
}

export const n8nProvider: ImageGenerationProvider = {
  id: "n8n",
  label: "n8n workflow",
  async: true,
  configured(): boolean {
    return !!getN8nWebhookUrl();
  },
  generate: (input: ImageGenerationInput) => handOff(input, "generate"),
  edit: (input: ImageGenerationInput) => handOff(input, "edit"),
};
