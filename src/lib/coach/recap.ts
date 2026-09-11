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
  /** Paste-ready plain-text follow-up email; first line is "Subject: …". */
  followUpEmail: string;
  /** One sentence: the recommended next action. */
  nextStep: string;
  /** Model that produced it + when (provenance). */
  model?: string;
  generatedAt: string;
}

const RECAP_MODEL = "claude-sonnet-5"; // Haiku is too shallow for the multi-field recap.
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
  "- Do NOT invent facts. If the call had too little signal, return short/empty fields rather than " +
  "guessing. Empty arrays are fine.\n" +
  "Output RAW JSON ONLY, no prose, no code fences, exactly this shape: " +
  '{"executive": string, "keyPoints": string[], "actionItems": string[], "customerConcerns": string[], ' +
  '"followUpEmail": string, "nextStep": string}';

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
  const user = `${who}${dir}\nTranscript:\n${trimmed}`;

  const r = await chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    { json: true, temperature: 0.3, model: RECAP_MODEL, maxTokens: 2048, timeoutMs: 60000 },
  );
  if (!r.ok || !r.text) return null;

  try {
    const p = extractJson(r.text) as Partial<Record<keyof CallRecap, unknown>>;
    const recap: CallRecap = {
      executive: typeof p.executive === "string" ? p.executive.trim() : "",
      keyPoints: strList(p.keyPoints),
      actionItems: strList(p.actionItems),
      customerConcerns: strList(p.customerConcerns),
      followUpEmail: typeof p.followUpEmail === "string" ? p.followUpEmail.trim() : "",
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
