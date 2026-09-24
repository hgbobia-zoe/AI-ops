// Shared Communications domain types. These are the abstractions the blade + API speak in. They
// REFERENCE existing entities (bookings, call_events, comms_events, risks) — they never re-model the
// customer/event/order data. Honesty is encoded structurally: anything that may be absent is nullable
// and rendered as "Unavailable" / "Not Connected" in the UI, never invented.

import type { CallReason } from "./reasons";

// ── Caller identity ──────────────────────────────────────────────────────────────────────────────
// Identity is a RULE result, not an AI guess. We match the caller's number to Zoe's bookings; the
// confidence is explicit so the UI (and any future voice agent) never silently assumes who is calling.
export type IdentityConfidence = "CONFIRMED" | "MULTIPLE_MATCHES" | "UNKNOWN";

export interface IdentityMatch {
  bookingId: string;
  name: string;
  email: string | null;
  phone: string | null;
  eventDate: string | null;
  status: string;
  signed: boolean;
}

export interface CallerIdentity {
  phone: string | null;
  phoneDigits: string | null; // last-10 normalized
  displayName: string; // resolved name, formatted phone, or "Unknown caller"
  confidence: IdentityConfidence;
  matches: IdentityMatch[];
  reason: string; // why this confidence (explainability)
}

// ── Context Pack ─────────────────────────────────────────────────────────────────────────────────
// The verified-facts bundle the Tower assembles for a caller — the object eventually handed to Sona.
// It contains ONLY things we can stand behind. Every list can be empty; every scalar can be null. The
// voice agent is never given raw DB access — this pack, plus the allowed-actions list, is the contract.
export interface ContextEventRef {
  bookingId: string;
  name: string;
  eventDate: string | null;
  status: string;
  signed: boolean;
  venue: string | null;
  location: string | null;
}

export interface ContextQuote {
  bookingId: string;
  name: string;
  eventDate: string | null;
  status: string;
  total: number | null; // dollars
  quoteSentDate: string | null;
  amountDue: number | null;
}

export interface ContextOrder {
  bookingId: string;
  name: string;
  eventDate: string | null;
  total: number | null; // dollars
  amountPaid: number | null;
  amountDue: number | null;
  signed: boolean;
  lineItems: string[] | null; // null = never captured (Unavailable), not "no items"
}

// Delivery / pickup derived from the dispatch layer (stops), matched by the customer's phone. When no
// stop is found the whole block is "UNAVAILABLE" — we never claim a window we don't have.
export type LogisticsAvailability = "SCHEDULED" | "IN_PROGRESS" | "COMPLETE" | "UNAVAILABLE";

export interface ContextLogistics {
  availability: LogisticsAvailability;
  window: string | null; // planned window text
  eta: string | null;
  state: string | null; // stop state
  address: string | null;
  routeId: string | null;
}

export interface ContextInteraction {
  channel: string; // call | sms | email
  direction: "inbound" | "outbound";
  when: string | null;
  preview: string;
  actor: string | null;
}

export interface ContextRisk {
  severity: string;
  title: string;
  date: string | null;
  category: string;
}

export interface ContextPack {
  generatedAt: string;
  caller: CallerIdentity;
  customer: { bookingId: string; name: string; email: string | null; phone: string | null } | null;
  events: ContextEventRef[];
  activeQuotes: ContextQuote[];
  orders: ContextOrder[];
  delivery: ContextLogistics;
  pickup: ContextLogistics;
  openIssues: { source: string; label: string; detail: string | null }[];
  recentInteractions: ContextInteraction[];
  operationalRisk: ContextRisk[];
  allowedActions: string[]; // tool names the agent MAY attempt for this caller (still permission-gated server-side)
  notes: string[]; // honest caveats surfaced to the operator (e.g. "Delivery unavailable — no matching stop")
}

// ── Queue rows ───────────────────────────────────────────────────────────────────────────────────
export type HandledBy = "AI" | "HUMAN" | "TRANSFERRED" | "UNKNOWN";
export type CallStatus = "RINGING" | "IN_PROGRESS" | "COMPLETED" | "MISSED" | "VOICEMAIL";
export type Disposition = "RESOLVED" | "UNRESOLVED" | "ESCALATED" | "FOLLOW_UP" | "UNKNOWN";

export interface QueueRow {
  id: string; // call_events.id
  providerId: string;
  occurredAt: string | null;
  ts: string;
  direction: "incoming" | "outgoing" | null;
  callerName: string;
  callerPhone: string | null;
  customerName: string | null; // matched booking client
  customerId: string | null; // matched booking id
  eventName: string | null;
  eventDate: string | null;
  reason: CallReason;
  reasonConfidence: number;
  reasonMethod: "heuristic" | "human";
  channel: "call" | "sms";
  handledBy: HandledBy;
  status: CallStatus;
  disposition: Disposition;
  sentiment: string | null;
  identityConfidence: IdentityConfidence;
  durationSec: number | null;
  riskCount: number; // open operational risks on the matched event(s)
}

// ── Call detail card ─────────────────────────────────────────────────────────────────────────────
export interface TranscriptTurn {
  speaker: "CUSTOMER" | "SONA" | "REP" | "UNKNOWN";
  raw: string; // the raw speaker label from the provider
  text: string;
}

export interface CallCard {
  row: QueueRow;
  transcript: TranscriptTurn[] | null; // null = "Transcript unavailable" (never fabricated)
  summary: string | null;
  actionsTaken: { label: string; detail: string | null; ts: string | null }[];
  context: ContextPack;
  handoff: HandoffBrief | null; // present when the call was transferred / a human is needed
}

// ── Human handoff ────────────────────────────────────────────────────────────────────────────────
export interface HandoffBrief {
  generatedAt: string;
  customer: string;
  event: string | null;
  reason: CallReason;
  reasonLabel: string;
  currentState: string; // what we know now (facts)
  requestedChange: string | null; // what the caller wants, if known (may be null)
  inventoryAvailability: string; // always honest — "Unavailable" until an inventory source exists
  aiRecommendation: string; // INFERENCE, labelled
  conversationSummary: string; // the AI/Quo summary or "Summary unavailable"
  identityConfidence: IdentityConfidence;
}
