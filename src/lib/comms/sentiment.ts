// Call-tone analysis for the customer-alerts feature. RULES CALCULATE, AI INTERPRETS:
//
//   1) heuristicSentiment() — deterministic, transparent keyword/structure scoring. Always available,
//      no LLM, no cost. It never claims more than it can see; it is the honest floor and the fallback.
//   2) analyzeSentiment() — tries the configured LLM FIRST (Ollama/local by default, via llm.ts which
//      auto-prefers LLM_BASE_URL) to judge nuanced frustration a keyword list misses. Falls back to the
//      heuristic silently when no model is configured, the model is down, or it returns invalid JSON.
//
// `method` records HOW the verdict was reached so an alert never overstates its confidence.

import { chat, llmConfigured } from "@/lib/llm";

export interface Sentiment {
  label: "positive" | "neutral" | "negative";
  score: number; // 0..1 — negativity / frustration confidence
  isNegative: boolean;
  method: "llm" | "heuristic";
  reasons: string[]; // short, specific — what drove the verdict
  llmModel?: string;
}

/** Flag threshold — at/above this negativity score a call is treated as "frustrated / at-risk". */
export const NEGATIVE_THRESHOLD = 0.5;

// Weighted negativity cues. Deliberately conservative — this is the fallback, not the primary judge.
const STRONG: [RegExp, string][] = [
  [/\bunacceptable\b/i, "unacceptable"],
  [/\bridiculous\b/i, "ridiculous"],
  [/\bnever again\b/i, "never again"],
  [/\bworst\b/i, "worst"],
  [/\bfurious\b/i, "furious"],
  [/\blawsuit\b|\bsue\b/i, "legal threat"],
  [/\brefund\b/i, "wants refund"],
  [/\bcancel\b/i, "cancel"],
  [/\bscam\b|\bripp?ed off\b/i, "scam / ripped off"],
  [/\bincompetent\b/i, "incompetent"],
  [/\bfed up\b|\bsick of\b/i, "fed up"],
  [/\bdisgusted\b|\bdisgrace\b/i, "disgusted"],
];
const MODERATE: [RegExp, string][] = [
  [/\bfrustrat/i, "frustrated"],
  [/\bangry\b|\bmad\b/i, "angry"],
  [/\bupset\b/i, "upset"],
  [/\bannoyed\b|\birritat/i, "annoyed"],
  [/\bdisappoint/i, "disappointed"],
  [/\bcomplaint?\b/i, "complaint"],
  [/\b(not|isn't|isnt|wasn't|wasnt) happy\b|\bunhappy\b/i, "unhappy"],
  [/\bterrible\b|\bawful\b|\bhorrible\b/i, "strongly negative"],
  [/\brude\b/i, "rude"],
  [/\bpoor service\b/i, "poor service"],
];
const MILD: [RegExp, string][] = [
  [/\blate\b|\bdelay/i, "late / delay"],
  [/\bwrong\b/i, "wrong"],
  [/\bbroke(n)?\b|\bdamaged?\b/i, "broken / damaged"],
  [/\bmissing\b/i, "missing"],
  [/\bwaiting\b|\bwaited\b/i, "waiting"],
  [/\bproblem\b|\bissue\b/i, "problem"],
  [/\bmistake\b/i, "mistake"],
  [/\bno one\b|\bnobody\b/i, "no one responded"],
];
const PROFANITY = /\b(damn|hell|crap|bullshit|wtf|f[\*u]ck|shit|ass(hole)?)\b/i;
const POSITIVE = /\b(thank you|thanks|great|perfect|appreciate|wonderful|awesome|excellent|love it|so happy|pleasure)\b/i;

/** Deterministic negativity score for a piece of call text. Pure — no I/O, fully testable. */
export function heuristicSentiment(text: string | null | undefined): Sentiment {
  const t = (text ?? "").trim();
  if (!t) return { label: "neutral", score: 0, isNegative: false, method: "heuristic", reasons: ["no transcript text"] };

  const reasons: string[] = [];
  let score = 0;
  const hit = (list: [RegExp, string][], weight: number): void => {
    for (const [re, label] of list) {
      if (re.test(t)) {
        score += weight;
        reasons.push(label);
      }
    }
  };
  hit(STRONG, 0.4);
  hit(MODERATE, 0.25);
  hit(MILD, 0.12);
  if (PROFANITY.test(t)) {
    score += 0.35;
    reasons.push("profanity");
  }

  // Structure: shouting (exclamations, ALL-CAPS words) adds a little; positive language pulls it down.
  const bangs = (t.match(/!/g) ?? []).length;
  if (bangs > 0) score += Math.min(0.15, bangs * 0.05);
  const capsWords = (t.match(/\b[A-Z]{3,}\b/g) ?? []).filter((w) => w !== "OK").length;
  if (capsWords >= 2) {
    score += Math.min(0.15, capsWords * 0.05);
    reasons.push("shouting (caps)");
  }
  const positive = POSITIVE.test(t);
  if (positive) score = Math.max(0, score - 0.2);

  score = Math.min(1, Math.round(score * 100) / 100);
  const label: Sentiment["label"] = score >= NEGATIVE_THRESHOLD ? "negative" : positive && score < 0.15 ? "positive" : "neutral";
  return {
    label,
    score,
    isNegative: score >= NEGATIVE_THRESHOLD,
    method: "heuristic",
    reasons: reasons.slice(0, 6),
    // no llmModel
  };
}

const SYSTEM =
  "You analyze the tone of a customer phone call for an event-rental company's operations team. " +
  "Judge the CUSTOMER's emotional tone — are they frustrated, irritated, angry, or upset? Ignore normal " +
  "logistics talk. Be conservative: only call it negative when the customer is genuinely unhappy, not " +
  "merely asking questions. Output RAW JSON ONLY — no markdown, no fences, no prose — exactly: " +
  '{"sentiment":"positive|neutral|negative","frustration":0.0,"reasons":["short phrase", "..."]}. ' +
  "frustration is 0.0–1.0. Keep reasons to at most 3 short, specific phrases grounded in what was said.";

function extractJson(text: string): unknown {
  let s = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}

/** Analyze call text: LLM-first (local/Ollama by default), deterministic heuristic as the fallback. */
export async function analyzeSentiment(text: string | null | undefined): Promise<Sentiment> {
  const heuristic = heuristicSentiment(text);
  const t = (text ?? "").trim();
  if (!llmConfigured() || !t) return heuristic;

  const r = await chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: t.slice(0, 12000) },
    ],
    { json: true, temperature: 0, timeoutMs: 45000 },
  );
  if (!r.ok || !r.text) return heuristic;

  try {
    const p = extractJson(r.text) as { sentiment?: unknown; frustration?: unknown; reasons?: unknown };
    const label: Sentiment["label"] =
      p.sentiment === "negative" || p.sentiment === "positive" ? p.sentiment : "neutral";
    const rawScore = typeof p.frustration === "number" ? p.frustration : label === "negative" ? 0.7 : 0;
    const score = Math.min(1, Math.max(0, Math.round(rawScore * 100) / 100));
    const reasons = Array.isArray(p.reasons) ? p.reasons.map(String).slice(0, 3) : [];
    return {
      label,
      score,
      isNegative: label === "negative" || score >= NEGATIVE_THRESHOLD,
      method: "llm",
      reasons: reasons.length ? reasons : heuristic.reasons,
      llmModel: r.model,
    };
  } catch {
    return heuristic; // model returned non-JSON — trust the deterministic read instead
  }
}
