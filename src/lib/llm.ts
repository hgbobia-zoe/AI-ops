// LLM client — used by the quote-review layer. Two backends:
//
//   • Anthropic (default when ANTHROPIC_API_KEY is set): Claude, e.g. Haiku — cheap,
//     fast, no infra. Model via LLM_MODEL (default claude-haiku-4-5-20251001).
//   • Any OpenAI Chat-Completions endpoint (when LLM_BASE_URL is set): a hosted open
//     model (Groq/Together/OpenRouter) or a local one (Ollama/LM Studio/vLLM).
//
// The deterministic crew rules always run for free; this only handles the fuzzy review,
// which is low-volume — so a cheap API beats self-hosting. Key-gated, never throws.

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

type Provider = "anthropic" | "openai";

function provider(): Provider | null {
  if (process.env.LLM_PROVIDER === "openai" && process.env.LLM_BASE_URL) return "openai";
  if (process.env.LLM_PROVIDER === "anthropic" && process.env.ANTHROPIC_API_KEY) return "anthropic";
  // Auto: prefer an explicit OpenAI-compatible endpoint, else Anthropic if its key is set.
  if (process.env.LLM_BASE_URL) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

export function llmConfigured(): boolean {
  return provider() !== null;
}

export function llmModel(): string {
  if (process.env.LLM_MODEL) return process.env.LLM_MODEL;
  return provider() === "anthropic" ? "claude-haiku-4-5-20251001" : "llama-3.1-8b-instant";
}

export async function chat(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const p = provider();
  if (!p) return { ok: false, error: "LLM not configured (set ANTHROPIC_API_KEY or LLM_BASE_URL)" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60000);
  try {
    return p === "anthropic"
      ? await chatAnthropic(messages, opts, ctrl.signal)
      : await chatOpenAI(messages, opts, ctrl.signal);
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function chatAnthropic(
  messages: ChatMessage[],
  opts: { temperature?: number },
  signal: AbortSignal,
): Promise<ChatResult> {
  // Anthropic takes the system prompt separately; the rest are user/assistant turns.
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: llmModel(),
      max_tokens: 1024,
      temperature: opts.temperature ?? 0.2,
      ...(system ? { system } : {}),
      messages: turns,
    }),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as {
    content?: { text?: string }[];
    error?: { message?: string };
    model?: string;
  };
  if (!res.ok) return { ok: false, error: `anthropic ${res.status}: ${data.error?.message ?? ""}`.trim() };
  const text = data.content?.map((c) => c.text ?? "").join("").trim();
  if (!text) return { ok: false, error: "empty completion" };
  return { ok: true, text, model: data.model };
}

async function chatOpenAI(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number },
  signal: AbortSignal,
): Promise<ChatResult> {
  const base = process.env.LLM_BASE_URL!.replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
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
    signal,
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
}

/** Trivial round-trip for an admin "Test connection". */
export async function testLlm(): Promise<ChatResult> {
  return chat([{ role: "user", content: "Reply with the single word: ok" }], { timeoutMs: 20000 });
}
