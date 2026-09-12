// Honest, computed conversation metrics for the Spiky-style coaching view. RULES CALCULATE: every
// number here is derived deterministically from the transcript + duration — we never invent
// "tone/patience/energy" scores we don't actually measure. Metrics degrade gracefully: if the
// transcript has no speaker labels, talk-balance is simply omitted rather than guessed.

export interface SpeakerShare {
  label: string; // "Rep" / "Customer" when identifiable, else the raw tag
  raw: string; // the original speaker tag (often a phone number)
  words: number;
  share: number; // 0..1 of the two-party total
}

export interface CallQuestion {
  speaker: string; // "Rep" / "Customer" when identifiable, else the raw tag
  text: string; // the question sentence, verbatim from the transcript
}

export interface CallMetrics {
  words: number;
  wordsPerMin: number | null; // total pace; null without a duration
  questions: number; // count of question sentences (== questionList.length)
  questionList: CallQuestion[]; // the actual questions asked, verbatim + who asked (discovery signal)
  turns: number; // labelled speaker segments
  speakers: SpeakerShare[]; // top 2 by words, when the transcript is speaker-labelled
}

const REP_HINT = /\b(rep|agent|sales|zoe|me|you|host)\b/i;
const CUST_HINT = /\b(customer|client|caller|prospect|them)\b/i;

/** Parse a transcript into per-speaker word counts + question/turn/pace stats. Lines are expected as
 *  "Label: text"; unlabelled lines fold into the previous speaker. `ourDigits` (Zoe's phone numbers)
 *  lets phone-numbered speakers be labelled Rep vs Customer. Safe on any string. */
export function computeCallMetrics(transcript: string, durationSec: number | null, ourDigits?: Set<string>): CallMetrics {
  const text = (transcript ?? "").trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const byLabel = new Map<string, number>();
  const questionList: CallQuestion[] = [];
  let lastLabel: string | null = null;
  let turns = 0;
  let totalWords = 0;

  const wc = (s: string): number => (s.match(/\b[\w'’-]+\b/g)?.length ?? 0);

  for (const line of lines) {
    const m = line.match(/^([^:]{1,40}?):\s*(.*)$/);
    let label: string | null;
    let body: string;
    if (m && m[1] && !/^https?$/i.test(m[1])) {
      label = m[1].trim();
      body = m[2] ?? "";
      turns++;
    } else {
      label = lastLabel;
      body = line;
    }
    lastLabel = label;
    const words = wc(body);
    totalWords += words;
    for (const q of extractQuestions(body)) {
      if (questionList.length < 50) questionList.push({ speaker: label ? prettyLabel(label, ourDigits) : "Speaker", text: q });
    }
    if (label) byLabel.set(label, (byLabel.get(label) ?? 0) + words);
  }

  const ranked = [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  const pairTotal = ranked.reduce((s, [, w]) => s + w, 0) || 1;
  const speakers: SpeakerShare[] = ranked.map(([label, words]) => ({
    raw: label,
    label: prettyLabel(label, ourDigits),
    words,
    share: words / pairTotal,
  }));

  const mins = durationSec && durationSec > 0 ? durationSec / 60 : null;
  return {
    words: totalWords,
    wordsPerMin: mins ? Math.round(totalWords / mins) : null,
    questions: questionList.length,
    questionList,
    turns,
    speakers: speakers.length >= 2 ? speakers : [],
  };
}

/** Pull the question sentences out of a line of dialogue. A single turn can hold several ("What's
 *  your date? And your budget?"); each chunk up to and including a '?' is one question. Deterministic. */
function extractQuestions(body: string): string[] {
  const out: string[] = [];
  for (const chunk of body.match(/[^.?!]*\?+/g) ?? []) {
    const t = chunk.trim().replace(/\s+/g, " ");
    if (t.length > 1) out.push(t);
  }
  return out;
}

// ---- Spiky-style gauges + momentum (all derived from the metrics above; transparent formulas) ----

export type GaugeTone = "good" | "warn" | "bad" | "neutral";
export interface Gauge {
  pct: number; // marker position 0..100 along the track
  label: string; // human verdict, e.g. "Good pace" / "Too fast"
  tone: GaugeTone;
}

/** Talking speed → verdict. Ranges tuned for phone sales calls (conversational ~110-165 wpm). */
export function speedGauge(wpm: number | null): Gauge | null {
  if (wpm == null) return null;
  const pct = Math.max(0, Math.min(100, ((wpm - 60) / (220 - 60)) * 100));
  if (wpm < 110) return { pct, label: "A bit slow", tone: "warn" };
  if (wpm > 190) return { pct, label: "Too fast", tone: "bad" };
  if (wpm > 165) return { pct, label: "A bit fast", tone: "warn" };
  return { pct, label: "Good pace", tone: "good" };
}

/** Talking time → verdict. repShare is the dominant speaker's share of the two-party words (0..1). */
export function balanceGauge(repShare: number | null): Gauge | null {
  if (repShare == null) return null;
  const pct = Math.max(0, Math.min(100, repShare * 100));
  if (repShare > 0.7) return { pct, label: "You talked a lot", tone: "bad" };
  if (repShare > 0.6) return { pct, label: "You led the talking", tone: "warn" };
  if (repShare < 0.3) return { pct, label: "You listened a lot", tone: "warn" };
  return { pct, label: "Well balanced", tone: "good" };
}

/** Customer tone → verdict, from the sentiment label (from the transcript/summary, not audio). */
export function sentimentGauge(sentiment: string | null): Gauge | null {
  if (!sentiment) return null;
  if (sentiment === "positive") return { pct: 82, label: "Positive", tone: "good" };
  if (sentiment === "negative") return { pct: 18, label: "Negative", tone: "bad" };
  return { pct: 50, label: "Neutral", tone: "neutral" };
}

export interface Momentum {
  score: number; // 0..100
  label: string; // Strong / Building / At risk
  tone: GaugeTone;
}

/** Call momentum — a transparent composite of the signals we actually have: customer sentiment,
 *  talk balance (discovery vs monologue), questions asked, and whether a next step was secured.
 *  NOT a black-box "AI score" — the formula is right here. */
export function momentumScore(input: {
  sentiment: string | null;
  repShare: number | null;
  questions: number | null;
  hasNextStep: boolean;
}): Momentum {
  let s = 50;
  if (input.sentiment === "positive") s += 20;
  else if (input.sentiment === "negative") s -= 25;
  if (input.repShare != null) {
    if (input.repShare >= 0.4 && input.repShare <= 0.6) s += 10;
    else if (input.repShare > 0.7) s -= 15;
    else if (input.repShare < 0.3) s += 4;
  }
  if (input.questions != null) {
    if (input.questions >= 3) s += 10;
    else if (input.questions >= 1) s += 5;
    else s -= 5;
  }
  if (input.hasNextStep) s += 10;
  s = Math.max(0, Math.min(100, Math.round(s)));
  if (s >= 70) return { score: s, label: "Strong", tone: "good" };
  if (s < 45) return { score: s, label: "At risk", tone: "bad" };
  return { score: s, label: "Building", tone: "warn" };
}

/** Map a raw speaker tag to Rep/Customer. A phone number is matched against Zoe's own numbers
 *  (ours ⇒ Rep, else Customer); otherwise fall back to keyword hints, then the raw tag. */
function prettyLabel(raw: string, ourDigits?: Set<string>): string {
  const digits = raw.replace(/\D/g, "");
  const d10 = digits.length >= 10 ? digits.slice(-10) : null;
  if (d10) return ourDigits?.has(d10) ? "Rep" : "Customer";
  if (REP_HINT.test(raw)) return "Rep";
  if (CUST_HINT.test(raw)) return "Customer";
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length > 16 ? t.slice(0, 15) + "…" : t;
}
