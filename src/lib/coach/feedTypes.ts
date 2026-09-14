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
}
export type TimelineItem = TextItem | CallItem;
