// LLM client — provider-agnostic, OpenAI Chat-Completions compatible.
//
// "Local LLM to save cost": point this at a LOCAL model and quote review is ~free.
// Anything that speaks the OpenAI /chat/completions shape works — Ollama
// (http://HOST:11434/v1), LM Studio, vLLM, OpenRouter, Together — and so does Anthropic
// via an OpenAI-compat gateway. Config via env (or later /admin):
//   LLM_BASE_URL   e.g. http://100.x.x.x:11434/v1   (Ollama over Tailscale)
//   LLM_MODEL      e.g. llama3.1:8b  ·  qwen2.5:7b-instruct
//   LLM_API_KEY    optional (Ollama ignores it; hosted gateways need it)
//
// Deployment note: the app runs on Fly, so a model on your office box must be reachable
// — expose Ollama over Tailscale (already installed) and use its tailnet IP as the host.
// Key-gated: llmConfigured() is false without LLM_BASE_URL, and callers fall back to the
// deterministic rules only. Never throws.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  ok: boolean;
  text?: string;
  error?: string;
  model?: string;
}

export function llmConfigured(): boolean {
  return Boolean(process.env.LLM_BASE_URL);
}

export function llmModel(): string {
  return process.env.LLM_MODEL || "llama3.1:8b";
}

/**
 * One chat completion. `json: true` asks for a JSON object back (best-effort — most
 * OpenAI-compatible servers honor response_format; Ollama also supports `format: json`).
 */
export async function chat(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const base = process.env.LLM_BASE_URL;
  if (!base) return { ok: false, error: "LLM not configured (set LLM_BASE_URL)" };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60000);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: llmModel(),
        messages,
        temperature: opts.temperature ?? 0.2,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string } | string;
      model?: string;
    };
    if (!res.ok) {
      const msg = typeof data.error === "string" ? data.error : data.error?.message;
      return { ok: false, error: `llm ${res.status}: ${msg ?? ""}`.trim() };
    }
    const text = data.choices?.[0]?.message?.content;
    if (!text) return { ok: false, error: "empty completion" };
    return { ok: true, text, model: data.model };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

/** Test the configured model with a trivial prompt. For an /admin "Test connection". */
export async function testLlm(): Promise<ChatResult> {
  return chat([{ role: "user", content: "Reply with the single word: ok" }], { timeoutMs: 20000 });
}
