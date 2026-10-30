// AI Org — the "last message" context an approval carries so the approver can see WHAT a drafted reply
// is responding to before they approve it. A compact, SERIALIZABLE snapshot of the most recent message
// in the client's thread, captured onto the approval payload when the draft is proposed (stable + cheap
// to render; no live lookup at approval-render time).
//
// This module is PURE and client-safe (no DB / server imports), so both the in-app ApprovalCard (client)
// and the Slack card (server) share one display contract. The extraction FROM the live merged timeline
// lives in salesos/timeline.ts (server). FACTS ONLY: a snapshot is only ever a real captured touch —
// when a lead has no prior message the proposer stores nothing and the card shows nothing (never a
// fabricated "last message").

import { DISPLAY_TZ } from "@/lib/dates";

export type LastMessageChannel = "sms" | "call" | "email" | "quote" | "note";

export interface LastMessageSnapshot {
  channel: LastMessageChannel;
  /** Direction from the CLIENT's perspective: in = they contacted us, out = we reached them, null = a
   *  directionless internal touch (e.g. a logged note). */
  direction: "in" | "out" | null;
  /** ISO instant, or null for an internal note dated only as written (no reliable year). */
  at: string | null;
  /** The note's date token exactly as written (e.g. "9/7") when `at` is null; else null. */
  rawDate: string | null;
  /** Who did it (rep initials/name) when known; null otherwise. */
  actor: string | null;
  /** The timeline entry's own label, e.g. "Text from client" / "Email received: ...". */
  title: string;
  /** The real captured body / summary / subject, truncated. null when the source carried no text. */
  snippet: string | null;
}

const CHANNEL_WORD: Record<LastMessageChannel, string> = {
  sms: "Text",
  call: "Call",
  email: "Email",
  quote: "Quote",
  note: "Note",
};

/** The "who" line for the snapshot, from the client's perspective, with the channel word + actor when
 *  known. Falls back to the entry's own title for a directionless internal touch. PURE. */
export function describeLastMessageWho(m: LastMessageSnapshot, clientName?: string | null): string {
  const channel = CHANNEL_WORD[m.channel] ?? "Message";
  const client = (clientName ?? "").trim() || "the client";
  if (m.direction === "in") return `${channel} from ${client}`;
  if (m.direction === "out") return m.actor ? `${channel} to ${client} (by ${m.actor})` : `${channel} to ${client}`;
  return m.actor ? `${m.title} (by ${m.actor})` : m.title;
}

/** A short, human-readable "when" for the snapshot, in the operating timezone (Eastern). An undated
 *  internal note keeps its written date token; an unparseable instant yields "". PURE. */
export function formatLastMessageWhen(m: LastMessageSnapshot): string {
  if (m.at) {
    const d = new Date(m.at);
    if (!Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: DISPLAY_TZ,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
    }
  }
  return m.rawDate ?? "";
}

/** Validate + narrow an unknown (e.g. a JSON-parsed approval payload field) to a LastMessageSnapshot.
 *  Returns null for anything that isn't a well-formed snapshot, so a malformed/absent field renders as
 *  "no prior message" rather than throwing. PURE. */
export function asLastMessageSnapshot(v: unknown): LastMessageSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.channel !== "string" || !(o.channel in CHANNEL_WORD)) return null;
  const direction = o.direction === "in" || o.direction === "out" ? o.direction : null;
  return {
    channel: o.channel as LastMessageChannel,
    direction,
    at: typeof o.at === "string" ? o.at : null,
    rawDate: typeof o.rawDate === "string" ? o.rawDate : null,
    actor: typeof o.actor === "string" ? o.actor : null,
    title: typeof o.title === "string" ? o.title : "",
    snippet: typeof o.snippet === "string" ? o.snippet : null,
  };
}
