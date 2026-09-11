// Honest, computed conversation metrics for the Spiky-style coaching view. RULES CALCULATE: every
// number here is derived deterministically from the transcript + duration — we never invent
// "tone/patience/energy" scores we don't actually measure. Metrics degrade gracefully: if the
// transcript has no speaker labels, talk-balance is simply omitted rather than guessed.

export interface SpeakerShare {
  label: string; // best-effort display label (raw speaker tag, or "You"/"Caller" when identifiable)
  words: number;
  share: number; // 0..1 of the two-party total
}

export interface CallMetrics {
  words: number;
  wordsPerMin: number | null; // total pace; null without a duration
  questions: number; // '?'-bearing segments (discovery signal)
  turns: number; // labelled speaker segments
  speakers: SpeakerShare[]; // top 2 by words, when the transcript is speaker-labelled
}

const REP_HINT = /\b(rep|agent|sales|zoe|me|you|host)\b/i;
const CUST_HINT = /\b(customer|client|caller|prospect|them)\b/i;

/** Parse a transcript into per-speaker word counts + question/turn/pace stats. Lines are expected as
 *  "Label: text"; unlabelled lines fold into the previous speaker. Safe on any string. */
export function computeCallMetrics(transcript: string, durationSec: number | null): CallMetrics {
  const text = (transcript ?? "").trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const byLabel = new Map<string, number>();
  let lastLabel: string | null = null;
  let turns = 0;
  let questions = 0;
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
    if (/\?/.test(body)) questions++;
    if (label) byLabel.set(label, (byLabel.get(label) ?? 0) + words);
  }

  const ranked = [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  const pairTotal = ranked.reduce((s, [, w]) => s + w, 0) || 1;
  const speakers: SpeakerShare[] = ranked.map(([label, words]) => ({
    label: prettyLabel(label),
    words,
    share: words / pairTotal,
  }));

  const mins = durationSec && durationSec > 0 ? durationSec / 60 : null;
  return {
    words: totalWords,
    wordsPerMin: mins ? Math.round(totalWords / mins) : null,
    questions,
    turns,
    speakers: speakers.length >= 2 ? speakers : [],
  };
}

/** Map a raw speaker tag to a friendly label when we recognise it; otherwise keep it (truncated). */
function prettyLabel(raw: string): string {
  if (REP_HINT.test(raw)) return "You";
  if (CUST_HINT.test(raw)) return "Caller";
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length > 16 ? t.slice(0, 15) + "…" : t;
}
