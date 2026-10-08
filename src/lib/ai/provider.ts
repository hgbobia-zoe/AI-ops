// AI Control Plane — the AIProvider abstraction. This is the ONE seam the rest of AIOps talks to when it
// wants AI interpretation. It mirrors the providers.ts pattern (GPS/SMS): a small `*Def` interface, a flat
// registry, lookup-by-id with a default fallback, config from the secrets store, and a client-safe catalog.
//
// Three adapters are registered, chosen in /admin like any other provider:
//   • session-bridge (DEFAULT) — a thin, REPLACEABLE handoff to a connected Claude / Claude Code session.
//       It makes NO paid API call per interaction. The session does the interpreting and posts its result
//       back through the registration API (see /api/ai). Because that is asynchronous, run() here returns
//       `skipped` honestly rather than fabricating an inline answer — callers fall back to their
//       deterministic rules, exactly like quoteReview's Tier-1 fallback.
//   • llm — backs onto the existing src/lib/llm.ts chat(), i.e. Claude via ANTHROPIC_API_KEY OR a local /
//       OpenAI-compatible model via LLM_BASE_URL. Used when a key is set; the ONLY adapter that calls out.
//   • remote-control — a placeholder for Claude Remote Control once a supported, documented mechanism
//       exists. Honest `skipped` until then; swapping it in is a one-line registry change.
//
// Governing law: RULES CALCULATE, AI INTERPRETS. A provider ONLY produces interpretation text/analysis.
// It never executes an operational write and never becomes the source of truth for a calculation. No
// Anthropic key is hardcoded here; credentials live in the secrets store and selection in settings.
// Server-only (reads secrets + settings). Never import into a client component.

import { getProviderConfig } from "@/lib/secrets";
import { getJson, setJson } from "@/lib/kv";
import { chat, testLlm, llmConfigured, llmModel, type ChatMessage } from "@/lib/llm";
import type { ProviderField } from "@/lib/providers";

export type AiProviderId = "session-bridge" | "llm" | "remote-control";

/** A bounded interpretation request. `context` carries the facts the deterministic rules already computed
 *  (RULES CALCULATE); the provider interprets them (AI INTERPRETS) — it is never asked to recompute them. */
export interface AiRunRequest {
  /** Optional system framing (the house COMMS_STYLE is added by llm.ts for prose calls). */
  system?: string;
  /** The interpretation task in plain words. */
  prompt: string;
  /** Rule-computed facts the interpretation should reason over (never recompute). */
  context?: Record<string, unknown>;
  /** Ask for a strict JSON object back (passed through to the model). */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface AiResult {
  ok: boolean;
  /** Not an error: the active provider cannot serve this inline (not connected / not keyed). The caller
   *  should fall back to its deterministic path. */
  skipped?: boolean;
  text?: string;
  model?: string;
  /** The adapter id that served (or declined) the request. */
  provider?: AiProviderId;
  error?: string;
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

export interface AiProviderDef {
  id: AiProviderId;
  name: string;
  /** How this adapter serves a request:
   *  - "inline": run() can return interpretation synchronously (llm).
   *  - "deferred": the work is handed to an external session; run() returns skipped (session-bridge). */
  mode: "inline" | "deferred";
  fields: ProviderField[];
  /** Config keys that MUST be present for this provider to serve inline. */
  requiredKeys: string[];
  run(req: AiRunRequest, cfg: Record<string, string>): Promise<AiResult>;
  test(cfg: Record<string, string>): Promise<TestResult>;
}

// Build the chat() message list from a request: system framing + the prompt with its rule-computed
// context appended as plain facts (never asking the model to recompute them).
function toMessages(req: AiRunRequest): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  if (req.system) msgs.push({ role: "system", content: req.system });
  const ctx =
    req.context && Object.keys(req.context).length
      ? `\n\nFacts already computed by the rules (interpret these, do not recompute):\n${JSON.stringify(req.context, null, 2)}`
      : "";
  msgs.push({ role: "user", content: `${req.prompt}${ctx}` });
  return msgs;
}

// ── session-bridge (default) ────────────────────────────────────────────────────
// A connected Claude / Claude Code session is marked live by the registration API (Phase 7), which flips
// this kv flag on heartbeat. run() never produces an inline answer — the session posts its result back
// asynchronously — so it returns skipped honestly. This is the "prioritise an existing session over a new
// paid API call" path the design requires, and it is fully replaceable behind this interface.
const BRIDGE_CONNECTED_KEY = "ai.bridge.connected";

/** Mark/read whether a Claude session bridge has checked in recently (set by the registration API). */
export function setBridgeConnected(connected: boolean): void {
  setJson(BRIDGE_CONNECTED_KEY, { connected, at: new Date().toISOString() });
}
export function bridgeConnected(): boolean {
  return getJson<{ connected?: boolean }>(BRIDGE_CONNECTED_KEY, {}).connected === true;
}

// ── Responder auth (headless bridge) ───────────────────────────────────────────
// The queue + bridge endpoints accept EITHER an owner/admin browser cookie OR a shared responder token in
// the `x-bridge-token` header. The token path only activates when AI_BRIDGE_TOKEN is set — a headless
// responder (an Agent-SDK worker or a Claude Code session) can't present a cookie. While it's unset, only
// the cookie path works, so there is no open hole: the responder simply isn't wired until the token is
// configured. Mirrors the GS_INGEST_TOKEN idiom, but gated-by-default (the responder can post into session
// timelines, so we never fail open).
export function bridgeTokenConfigured(): boolean {
  return !!process.env.AI_BRIDGE_TOKEN;
}
export function bridgeTokenValid(token: string | null | undefined): boolean {
  const expected = process.env.AI_BRIDGE_TOKEN;
  return !!expected && typeof token === "string" && token.length > 0 && token === expected;
}

const sessionBridge: AiProviderDef = {
  id: "session-bridge",
  name: "Claude Session Bridge",
  mode: "deferred",
  fields: [],
  requiredKeys: [],
  async run() {
    // Deferred by design: the connected session interprets and posts back via /api/ai. Never fabricate.
    return {
      ok: false,
      skipped: true,
      provider: "session-bridge",
      error: bridgeConnected()
        ? "Handed to the connected Claude session; its result arrives via the registration API."
        : "No Claude session is connected. Open a session or switch the AI provider to a keyed LLM.",
    };
  },
  async test() {
    return bridgeConnected() ? { ok: true } : { ok: false, error: "no Claude session connected" };
  },
};

// ── llm (keyed Claude or local model) ────────────────────────────────────────────
// The only adapter that calls out. Delegates to llm.ts chat(), which is key-gated and never throws. Its
// credentials are env/Fly-secret driven (ANTHROPIC_API_KEY or LLM_BASE_URL+LLM_API_KEY), not the per-
// provider secrets store, so `fields` is empty — matching how the GPS Zonar provider declares no fields.
const llmAdapter: AiProviderDef = {
  id: "llm",
  name: "Claude / local LLM (API key)",
  mode: "inline",
  fields: [],
  requiredKeys: [],
  async run(req) {
    if (!llmConfigured()) {
      return { ok: false, skipped: true, provider: "llm", error: "LLM not configured (set ANTHROPIC_API_KEY or LLM_BASE_URL)" };
    }
    const r = await chat(toMessages(req), { json: req.json, temperature: req.temperature, maxTokens: req.maxTokens, timeoutMs: req.timeoutMs });
    return { ok: r.ok, text: r.text, model: r.model ?? llmModel(), provider: "llm", error: r.error };
  },
  async test() {
    if (!llmConfigured()) return { ok: false, error: "LLM not configured" };
    const r = await testLlm();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

// ── remote-control (placeholder) ─────────────────────────────────────────────────
// Reserved for Claude Remote Control once a supported, documented mechanism exists. Honest skip until
// then — nothing in the app depends on an undocumented private API as core production architecture.
const remoteControl: AiProviderDef = {
  id: "remote-control",
  name: "Claude Remote Control (not yet available)",
  mode: "deferred",
  fields: [],
  requiredKeys: [],
  async run() {
    return { ok: false, skipped: true, provider: "remote-control", error: "Remote Control has no supported mechanism wired yet." };
  },
  async test() {
    return { ok: false, error: "not available" };
  },
};

export const AI_PROVIDERS: AiProviderDef[] = [sessionBridge, llmAdapter, remoteControl];

// ── Registry helpers (mirror providers.ts) ───────────────────────────────────────

export function aiProviderById(id: string): AiProviderDef {
  return AI_PROVIDERS.find((p) => p.id === id) ?? sessionBridge;
}

const ACTIVE_KEY = "ai.activeProvider";

/** The active adapter id (chosen in /admin). Defaults to session-bridge — the no-paid-API path. */
export function activeAiProviderId(): AiProviderId {
  const v = getJson<{ id?: string }>(ACTIVE_KEY, {}).id;
  return v && AI_PROVIDERS.some((p) => p.id === v) ? (v as AiProviderId) : "session-bridge";
}

export function setActiveAiProvider(id: AiProviderId): void {
  setJson(ACTIVE_KEY, { id, at: new Date().toISOString() });
}

/** Load a provider's stored credentials from the secrets store (empty for field-less adapters). */
export function loadAiConfig(id: string): Record<string, string> {
  const def = aiProviderById(id);
  return def.fields.length ? getProviderConfig(id, def.fields.map((f) => f.key)) : {};
}

/** Run an interpretation through the ACTIVE provider. Never throws; an unavailable provider yields a
 *  `skipped` result so the caller can fall back to its deterministic path. */
export async function runAi(req: AiRunRequest): Promise<AiResult> {
  const def = aiProviderById(activeAiProviderId());
  try {
    return await def.run(req, loadAiConfig(def.id));
  } catch (e) {
    return { ok: false, provider: def.id, error: String(e) };
  }
}

/** Can the active provider serve an interpretation inline right now? (session-bridge is always deferred.) */
export function aiConfigured(): boolean {
  const def = aiProviderById(activeAiProviderId());
  if (def.mode !== "inline") return false;
  if (def.id === "llm") return llmConfigured();
  return def.requiredKeys.every((k) => !!loadAiConfig(def.id)[k]);
}

// ── Client-safe catalog (no functions) for the /admin form ────────────────────────
export interface AiProviderMeta {
  id: AiProviderId;
  name: string;
  mode: "inline" | "deferred";
  fields: ProviderField[];
  active: boolean;
}
export function aiProviderCatalog(): AiProviderMeta[] {
  const active = activeAiProviderId();
  return AI_PROVIDERS.map((p) => ({ id: p.id, name: p.name, mode: p.mode, fields: p.fields, active: p.id === active }));
}
