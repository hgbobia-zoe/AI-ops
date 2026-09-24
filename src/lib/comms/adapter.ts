// The ADAPTER layer — the seam that keeps the Tower independent of any one telephony vendor's payload.
// Quo (OpenPhone) today, Sona (the AI voice agent) tomorrow, or anything else: whatever shape arrives at
// POST /api/communications/events is normalized HERE into a canonical event before it touches the log or
// the rest of the system. We deliberately do NOT hard-code Quo's final webhook schema (it isn't
// finalized) — the adapter maps what it recognizes and passes the rest through, tagged, without losing
// the raw payload. RULES: we never invent fields; unknown maps to a canonical "unknown" type, not a guess.

import type { CommsLogInput } from "./store";

// The canonical event vocabulary the Tower speaks internally, regardless of source.
export type CanonicalEventType =
  | "call.started"
  | "call.answered"
  | "call.ended"
  | "call.transferred"
  | "call.missed"
  | "recording.available"
  | "transcript.available"
  | "sms.received"
  | "sms.sent"
  | "unknown";

export const CANONICAL_EVENT_TYPES: CanonicalEventType[] = [
  "call.started", "call.answered", "call.ended", "call.transferred", "call.missed",
  "recording.available", "transcript.available", "sms.received", "sms.sent", "unknown",
];

// Provider event type → canonical. Prefix/keyword matched so minor vendor variations still map.
function toCanonical(rawType: string, direction?: string | null): CanonicalEventType {
  const t = rawType.toLowerCase();
  if (t.includes("transcript")) return "transcript.available";
  if (t.includes("summary")) return "transcript.available";
  if (t.includes("recording")) return "recording.available";
  if (t.includes("transfer")) return "call.transferred";
  if (t.includes("missed") || t.includes("no-answer") || t.includes("no_answer")) return "call.missed";
  if (t.startsWith("call")) {
    if (t.includes("ring") || t.includes("initiated") || t.includes("started")) return "call.started";
    if (t.includes("answer")) return "call.answered";
    if (t.includes("complete") || t.includes("ended") || t.includes("end")) return "call.ended";
    return "call.ended";
  }
  if (t.startsWith("message") || t.includes("sms")) {
    if (t.includes("received") || direction === "incoming" || direction === "inbound") return "sms.received";
    return "sms.sent";
  }
  return "unknown";
}

export interface RawEvent {
  type?: string;
  eventType?: string;
  source?: string; // "quo" | "sona" | ... (a caller hint)
  id?: string;
  conversationId?: string;
  callId?: string;
  direction?: string;
  from?: string;
  to?: string | string[];
  occurredAt?: string;
  createdAt?: string;
  data?: { object?: Record<string, unknown> };
  [k: string]: unknown;
}

export interface AdaptResult {
  recognized: boolean;
  canonicalType: CanonicalEventType;
  event: CommsLogInput;
}

const firstTo = (to: unknown): string | null => (Array.isArray(to) ? (to[0] ? String(to[0]) : null) : typeof to === "string" ? to : null);

/** Normalize a raw provider event into a canonical, source-independent log entry. Never throws; an
 *  unmappable event still logs (type "unknown") so nothing is silently dropped. */
export function adaptEvent(raw: RawEvent): AdaptResult {
  const obj = (raw.data?.object as Record<string, unknown> | undefined) ?? {};
  const rawType = String(raw.type ?? raw.eventType ?? (obj.type as string) ?? "").trim();
  const direction = (raw.direction ?? (obj.direction as string) ?? null) as string | null;
  const canonicalType = toCanonical(rawType, direction);
  const source = (raw.source === "sona" ? "sona" : raw.source === "system" ? "system" : "quo") as CommsLogInput["source"];

  const conversationId = String(
    raw.conversationId ?? raw.callId ?? (obj.callId as string) ?? (obj.id as string) ?? raw.id ?? `conv-${Date.now()}`,
  );
  const providerEventId = String(raw.id ?? (obj.id as string) ?? `${conversationId}:${rawType || canonicalType}`);
  const channel = canonicalType.startsWith("sms") ? "sms" : "call";
  const dir: "inbound" | "outbound" | null =
    direction === "incoming" || direction === "inbound" || canonicalType === "sms.received"
      ? "inbound"
      : direction === "outgoing" || direction === "outbound" || canonicalType === "sms.sent"
        ? "outbound"
        : null;

  return {
    recognized: canonicalType !== "unknown",
    canonicalType,
    event: {
      conversationId,
      providerEventId,
      source,
      channel,
      eventType: canonicalType,
      direction: dir,
      fromPhone: (raw.from ?? (obj.from as string) ?? null) as string | null,
      toPhone: firstTo(raw.to ?? obj.to) ?? null,
      occurredAt: (raw.occurredAt ?? raw.createdAt ?? (obj.completedAt as string) ?? (obj.createdAt as string) ?? null) as string | null,
      payload: { rawType, canonicalType, object: obj },
    },
  };
}
