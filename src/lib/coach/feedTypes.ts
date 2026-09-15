// Shared conversation-feed item types (client-safe: no imports). A lead/customer conversation is a
// merge of calls (from call_events, with their AI summary) + texts (from comms_events), chronological.

export interface TextItem {
  kind: "text";
  id: string;
  direction: string | null;
  body: string;
  actor: string | null;
  at: string | null;
}
/** The teaching layer from a call's recap, surfaced next to the call. Present only when analyzed and
 *  at least one field is non-empty. */
export interface CallCoachingItem {
  notes: string[]; // coaching critique — what the rep could tighten
  objections: { objection: string; response: string }[];
  concerns: string[]; // customer concerns raised
  actionItems: string[]; // what the rep committed to
}
/** Instant, deterministic call signals (computed from the transcript, no LLM) — available as soon as a
 *  call has a transcript, before the AI recap is written. */
export interface CallSignals {
  wordsPerMin: number | null;
  repSharePct: number | null; // rep's share of the talking, or null when the transcript isn't labelled
  questions: number; // discovery questions asked
  momentum: { score: number; label: string; tone: "good" | "warn" | "bad" | "neutral" };
}
export interface CallItem {
  kind: "call";
  id: string;
  direction: string | null;
  at: string | null;
  durationSec: number | null;
  sentiment: string | null;
  summary: string[]; // key points, or the Quo summary as one bullet
  nextStep: string;
  analyzed: boolean;
  coaching: CallCoachingItem | null;
  signals: CallSignals | null;
}
export interface EmailItem {
  kind: "email";
  id: string;
  at: string | null;
  subject: string;
  via: string; // e.g. "Goodshuffle"
}
export type TimelineItem = TextItem | CallItem | EmailItem;
