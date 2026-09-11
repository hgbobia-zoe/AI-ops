// Post-call coaching recap — Custodian's coaching brain, brought into Maestro. Takes a finished
// call transcript (from call_events, ingested via the OpenPhone/Quo webhook) and produces the same
// structured recap the Custodian desktop app gives reps live: executive summary, key points, the
// rep's action items, customer concerns, a paste-ready follow-up email, and a recommended next step.
//
// This is the SalesCoach `generateCallSummary` prompt + output shape, re-expressed on Maestro's own
// LLM helper (src/lib/llm.ts `chat`) instead of the Anthropic SDK tool-call, so it uses Maestro's
// key-gating, timeouts, and provider config. Faithful to Custodian; consistent with this codebase.
// Key-gated + never throws — returns null when the LLM isn't configured or the output is unusable.
// RULES CALCULATE, AI INTERPRETS: the recap is INFERENCE over what was said; it never invents facts.

import { chat, llmConfigured } from "@/lib/llm";

export interface CallRecap {
  /** 1-2 paragraph summary of what was discussed (80-200 words). */
  executive: string;
  /** 4-8 bullets covering what came up, oldest to newest. */
  keyPoints: string[];
  /** Things THE REP committed to do post-call (verb-first). */
  actionItems: string[];
  /** Objections/concerns the customer raised. Empty if none surfaced. */
  customerConcerns: string[];
  /** Each objection paired with a recommended way to handle it (Spiky's objection→response). */
  objections: { objection: string; response: string }[];
  /** Paste-ready plain-text follow-up email; first line is "Subject: …". */
  followUpEmail: string;
  /** Coaching critique — specific, kind, actionable notes on what the rep could have done better
   *  (a sharper question, a stronger objection response, a clearer close). The teaching layer. */
  coachingNotes: string[];
  /** One sentence: the recommended next action. */
  nextStep: string;
  /** Model that produced it + when (provenance). */
  model?: string;
  generatedAt: string;
}

// Model is configurable so the analysis can run on a LOCAL / open model (point chat() at an
// OpenAI-compatible endpoint via LLM_BASE_URL — Ollama/vLLM/Groq/etc.) instead of a paid cloud call.
// COACH_MODEL overrides just the coaching model; unset ⇒ chat()'s default (llmModel()), which already
// respects LLM_BASE_URL/LLM_MODEL/ANTHROPIC_API_KEY. Feeding Quo's own summary in as context lets a
// smaller model lean on work Quo already did rather than re-deriving everything.
const COACH_MODEL = process.env.COACH_MODEL?.trim() || undefined;
const MAX_TRANSCRIPT_CHARS = 16_000;

const SYSTEM =
  "You are an executive assistant summarizing a finished sales call for the rep who just took it, at " +
  "Zoe Events (a premium DC/MD/VA event-rental company). The rep needs a tight, honest recap they can " +
  "read in under a minute.\n" +
  "Style rules:\n" +
  "- Concrete, never marketing-y: 'Customer wanted 3 generators for a September 14 wedding', not " +
  "'expressed enthusiasm about power solutions'.\n" +
  "- Surface SPECIFIC numbers, dates, names, and equipment when present.\n" +
  "- The follow-up email must read like the rep wrote it, paste-ready, no 'Dear valued customer'. " +
  "Friendly and direct.\n" +
  "- Action items are things THE REP committed to do, not what the customer will do.\n" +
  "- Zoe wins on reliability and execution, not price — never suggest discounting as the next step.\n" +
  "- objections: for each real concern the customer raised (price, timing, competitor, fit, authority), " +
  "output {objection: what they raised, in their terms, response: a specific, non-discounting way to " +
  "handle it, grounded in Zoe's reliability/execution and in what was actually said}. Empty array if none.\n" +
  "- coachingNotes: put on your SALES-COACH hat. Give 2-5 specific, kind, actionable notes on what " +
  "the rep could have done better — a sharper discovery question, a stronger way to handle an " +
  "objection the customer actually raised, a clearer next-step ask. Ground each note in what actually " +
  "happened on THIS call (quote or paraphrase the moment); never generic advice. If the rep did well, " +
  "say what worked and one thing to reinforce. Empty array only if there's truly nothing to coach.\n" +
  "- Do NOT invent facts. If the call had too little signal, return short/empty fields rather than " +
  "guessing. Empty arrays are fine.\n" +
  "Output RAW JSON ONLY, no prose, no code fences, exactly this shape: " +
  '{"executive": string, "keyPoints": string[], "actionItems": string[], "customerConcerns": string[], ' +
  '"objections": [{"objection": string, "response": string}], "followUpEmail": string, ' +
  '"coachingNotes": string[], "nextStep": string}';

function extractJson(text: string): unknown {
  let s = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const f = s.indexOf("{");
  const l = s.lastIndexOf("}");
  if (f >= 0 && l > f) s = s.slice(f, l + 1);
  return JSON.parse(s);
}

const strList = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];

export interface RecapInput {
  transcript: string;
  direction?: string | null;
  contactName?: string | null;
  durationSec?: number | null;
  /** Quo's own AI call summary, if available — passed in as grounding context for the analysis. */
  quoSummary?: string | null;
}

/** Generate a coaching recap for one finished call. Returns null when the LLM is unconfigured, the
 *  transcript is empty, or the model returns unusable output (caller shows "not analyzed"). */
export async function generateRecap(input: RecapInput): Promise<CallRecap | null> {
  const transcript = (input.transcript ?? "").trim();
  if (!transcript || !llmConfigured()) return null;

  // Keep the END of a long transcript — call closings carry the action items and next steps.
  const trimmed =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? "…[earlier portion of call omitted for length]…\n\n" + transcript.slice(-MAX_TRANSCRIPT_CHARS)
      : transcript;

  const who = input.contactName ? `Contact: ${input.contactName}\n` : "";
  const dir = input.direction ? `Direction: ${input.direction}\n` : "";
  const quo = input.quoSummary?.trim() ? `Quo's AI call summary (reference — build on it, don't just repeat it):\n${input.quoSummary.trim()}\n\n` : "";
  const user = `${who}${dir}\n${quo}Transcript:\n${trimmed}`;

  const r = await chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    { json: true, temperature: 0.3, model: COACH_MODEL, maxTokens: 2048, timeoutMs: 90000 },
  );
  if (!r.ok || !r.text) return null;

  try {
    const p = extractJson(r.text) as Partial<Record<keyof CallRecap, unknown>>;
    const recap: CallRecap = {
      executive: typeof p.executive === "string" ? p.executive.trim() : "",
      keyPoints: strList(p.keyPoints),
      actionItems: strList(p.actionItems),
      customerConcerns: strList(p.customerConcerns),
      objections: Array.isArray(p.objections)
        ? (p.objections as unknown[])
            .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
            .map((o) => ({
              objection: typeof o.objection === "string" ? o.objection.trim() : "",
              response: typeof o.response === "string" ? o.response.trim() : "",
            }))
            .filter((o) => o.objection || o.response)
        : [],
      followUpEmail: typeof p.followUpEmail === "string" ? p.followUpEmail.trim() : "",
      coachingNotes: strList(p.coachingNotes),
      nextStep: typeof p.nextStep === "string" ? p.nextStep.trim() : "",
      model: r.model,
      generatedAt: new Date().toISOString(),
    };
    // All-empty ⇒ treat as failure so the caller doesn't store an empty husk.
    if (!recap.executive && recap.keyPoints.length === 0 && recap.actionItems.length === 0 && !recap.followUpEmail) {
      return null;
    }
    return recap;
  } catch {
    return null;
  }
}
