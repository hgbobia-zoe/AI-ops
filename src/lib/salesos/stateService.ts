// Customer state service (Phase 5) — resolves and stores a lead's evidence-driven state.
//   • resolveDeterministic: FACT-only, instant, no AI — used everywhere (command center scans all leads).
//   • resolveAndStore: on a new inbound reply (or on demand), the AI classifies the reply and refines
//     the state (INFERENCE), stored with confidence + the quote. Falls back to deterministic silently.

import { getBookingById, getLatestInboundForLead, getLastCommsAt, getCommsForLead, getCustomerState, upsertCustomerState, type BookingView, type CustomerStateRow } from "@/lib/db/repo";
import { sentFromStatus } from "./calc";
import { chat, llmConfigured } from "@/lib/llm";
import { todayInOpsTz } from "@/lib/dates";
import { deterministicState, foldReply, ALL_CUSTOMER_STATES, type StateFacts, type ResolvedState, type ReplyClassification, type CustomerState } from "./state";

function daysBetween(fromYmdOrIso: string, toYmd: string): number {
  const a = Date.parse(fromYmdOrIso.length > 10 ? fromYmdOrIso : `${fromYmdOrIso}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Number.isFinite(a) ? Math.max(0, Math.round((b - a) / 86_400_000)) : 0;
}

function factsFor(b: BookingView, leadId: string): StateFacts {
  const today = todayInOpsTz();
  const lastComms = getLastCommsAt(leadId);
  const anchor = lastComms ?? b.quoteSentDate ?? b.dateCreated ?? null;
  return {
    signed: b.signed,
    statusLabel: b.statusLabel,
    everSent: sentFromStatus(b.statusLabel) ?? !!b.quoteSentDate,
    daysSinceLastActivity: anchor ? daysBetween(anchor, today) : null,
  };
}

/** FACT-only state for a booking (instant, no AI). */
export function resolveDeterministic(b: BookingView): ResolvedState {
  return deterministicState(factsFor(b, b.bookingId));
}

/** Minutes since the lead's most recent inbound reply, or null — the "just replied" signal. */
export function replyMinutesAgo(leadId: string): number | null {
  const inbound = getLatestInboundForLead(leadId);
  const iso = inbound?.occurredAt ?? inbound?.ts ?? null;
  if (!iso) return null;
  const t = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60_000)) : null;
}

/** Turn a stored row back into a ResolvedState shape. */
export function fromStored(r: CustomerStateRow): ResolvedState {
  return {
    state: (ALL_CUSTOMER_STATES.includes(r.state as CustomerState) ? r.state : "QUOTED") as CustomerState,
    confidence: r.confidence ?? 0.6,
    evidence: r.evidence ?? "",
    source: (r.source as ResolvedState["source"]) ?? "derived",
    reason: r.reason ?? "",
  };
}

const CLASSIFY_STATES: CustomerState[] = ["EVALUATING", "PRICE_OBJECTION", "LOGISTICS_OBJECTION", "PRODUCT_UNCERTAINTY", "COMPETITOR_COMPARISON", "READY_TO_BOOK", "QUOTED"];

const SYSTEM =
  "You classify a customer's reply to an event-rental quote into ONE sales state. Allowed states: " +
  "EVALUATING (weighing it), PRICE_OBJECTION (price is too high / more than expected), LOGISTICS_OBJECTION " +
  "(timing/delivery/access question), PRODUCT_UNCERTAINTY (unsure what they need), COMPETITOR_COMPARISON " +
  "(comparing other vendors), READY_TO_BOOK (wants to move forward/confirm), QUOTED (unclear/generic). " +
  "Be conservative: if the reply is ambiguous, use QUOTED with low confidence. Output RAW JSON ONLY — no " +
  'markdown/fences — exactly: {"state": "...", "confidence": 0.0, "evidenceQuote": "the customer\'s words"}.';

function extractJson(text: string): unknown {
  let s = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}

/** AI-classify a single inbound reply. Returns null when no LLM, empty text, or an unparseable result —
 *  never a guess. */
export async function classifyReply(message: string): Promise<ReplyClassification | null> {
  const m = (message ?? "").trim();
  if (!llmConfigured() || !m) return null;
  const r = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: m.slice(0, 2000) }], { json: true, temperature: 0, timeoutMs: 30000 });
  if (!r.ok || !r.text) return null;
  try {
    const p = extractJson(r.text) as { state?: unknown; confidence?: unknown; evidenceQuote?: unknown };
    const state = CLASSIFY_STATES.includes(p.state as CustomerState) ? (p.state as CustomerState) : "QUOTED";
    const confidence = typeof p.confidence === "number" ? Math.min(1, Math.max(0, p.confidence)) : 0.4;
    const evidenceQuote = typeof p.evidenceQuote === "string" && p.evidenceQuote.trim() ? p.evidenceQuote.trim() : m.slice(0, 160);
    return { state, confidence, evidenceQuote };
  } catch {
    return null;
  }
}

/** Resolve a lead's state (deterministic base + AI reply classification) and store it if it changed.
 *  Called on a new inbound reply and on-demand. Best-effort; returns the resolved state. */
export async function resolveAndStore(leadId: string): Promise<ResolvedState | null> {
  const b = getBookingById(leadId);
  if (!b) return null;
  const base = resolveDeterministic(b);

  let resolved = base;
  if (base.state !== "WON" && base.state !== "LOST") {
    const inbound = getLatestInboundForLead(leadId);
    if (inbound?.body) {
      const cls = await classifyReply(inbound.body);
      resolved = foldReply(base, cls);
    }
  }
  return storeIfChanged(leadId, resolved);
}

const CALL_SYSTEM =
  "You are reading a TRANSCRIPT (or summary) of a phone call between a Zoe event-rental sales rep and a " +
  "prospective customer. Classify the CUSTOMER's stance coming out of the call into ONE sales state. " +
  "Allowed states: EVALUATING (weighing it), PRICE_OBJECTION (price too high / more than expected), " +
  "LOGISTICS_OBJECTION (timing/delivery/access/venue concern), PRODUCT_UNCERTAINTY (unsure what they need), " +
  "COMPETITOR_COMPARISON (comparing other vendors), READY_TO_BOOK (wants to move forward/confirm), QUOTED " +
  "(unclear/generic). Judge the CUSTOMER only, not the rep. Be conservative: if the call is ambiguous, " +
  "small talk, logistics-scheduling only, or you cannot tell, use QUOTED with low confidence. Output RAW " +
  'JSON ONLY — no markdown/fences — exactly: {"state": "...", "confidence": 0.0, "evidenceQuote": "a short quote of what the customer said"}.';

/** AI-classify the customer's stance from a call transcript/summary. Same shape as classifyReply, but a
 *  call-aware prompt. Returns null when no LLM, empty text, or an unparseable result — never a guess. */
export async function classifyCall(transcript: string): Promise<ReplyClassification | null> {
  const m = (transcript ?? "").trim();
  if (!llmConfigured() || !m) return null;
  const r = await chat([{ role: "system", content: CALL_SYSTEM }, { role: "user", content: m.slice(0, 6000) }], { json: true, temperature: 0, timeoutMs: 30000 });
  if (!r.ok || !r.text) return null;
  try {
    const p = extractJson(r.text) as { state?: unknown; confidence?: unknown; evidenceQuote?: unknown };
    const state = CLASSIFY_STATES.includes(p.state as CustomerState) ? (p.state as CustomerState) : "QUOTED";
    const confidence = typeof p.confidence === "number" ? Math.min(1, Math.max(0, p.confidence)) : 0.4;
    const evidenceQuote = typeof p.evidenceQuote === "string" && p.evidenceQuote.trim() ? p.evidenceQuote.trim() : m.slice(0, 160);
    return { state, confidence, evidenceQuote };
  } catch {
    return null;
  }
}

/** Post-call debrief (Phase 11): fold a real conversation's classification into the lead's state and
 *  store it if it changed. Deterministic base always wins for WON/LOST. `text` should be an actual
 *  conversation (transcript preferred, else summary) — callers gate out voicemails/short calls, so a
 *  low-signal call simply leaves the deterministic state in place. Best-effort. */
export async function debriefCall(leadId: string, text: string): Promise<ResolvedState | null> {
  const b = getBookingById(leadId);
  if (!b) return null;
  const base = resolveDeterministic(b);
  let resolved = base;
  if (base.state !== "WON" && base.state !== "LOST") {
    const cls = await classifyCall(text);
    resolved = foldReply(base, cls);
  }
  return storeIfChanged(leadId, resolved);
}

// ── Full context re-analysis (reads the Goodshuffle activity log + messages, not just recency) ──────
const CONTEXT_STATES: CustomerState[] = ["EVALUATING", "PRICE_OBJECTION", "LOGISTICS_OBJECTION", "PRODUCT_UNCERTAINTY", "COMPETITOR_COMPARISON", "READY_TO_BOOK", "DORMANT", "QUOTED"];
const CONTEXT_SYSTEM =
  "You are analyzing everything known about ONE event-rental lead — the Goodshuffle ACTIVITY LOG (dated " +
  "notes of calls/texts/emails the sales team logged), recent messages, and status — to determine the " +
  "CUSTOMER's CURRENT sales state. Weigh the MOST RECENT dated entries most: if the team recently REACHED " +
  "the customer (they answered, replied, or gave any signal), the lead is NOT dormant even if the quote is " +
  "old. Only use DORMANT when there has been NO successful contact for a long stretch AND recent attempts " +
  "went unanswered. Allowed states: EVALUATING (weighing it / awaiting their update), PRICE_OBJECTION, " +
  "LOGISTICS_OBJECTION, PRODUCT_UNCERTAINTY, COMPETITOR_COMPARISON, READY_TO_BOOK, DORMANT, QUOTED (unclear). " +
  "Judge the CUSTOMER, not the rep. Output RAW JSON ONLY — no markdown/fences — exactly: " +
  '{"state":"...","confidence":0.0,"evidence":"the most recent relevant fact from the log","reason":"one short sentence of why"}.';

/** Re-analyze a lead's state from its FULL context — the Goodshuffle activity log (internal notes),
 *  client note, and recent messages — not just contact recency. Fixes false "Dormant" when the team
 *  actually reached the customer (it's logged in the notes). FACT states (WON/LOST/NEW) always win.
 *  Stores the refreshed state. Best-effort: no LLM / unparseable ⇒ keeps the deterministic state. */
export async function reanalyzeLead(leadId: string): Promise<ResolvedState | null> {
  const b = getBookingById(leadId);
  if (!b) return null;
  const base = resolveDeterministic(b);
  // Signed / lost / not-yet-sent are FACTs — no re-interpretation.
  if (base.state === "WON" || base.state === "LOST" || base.state === "NEW" || !llmConfigured()) {
    upsertCustomerState({ leadId, state: base.state, confidence: base.confidence, evidence: base.evidence, source: base.source, reason: base.reason });
    return base;
  }
  const today = todayInOpsTz();
  const comms = getCommsForLead(leadId, 12)
    .reverse()
    .map((c) => `${c.direction === "inbound" ? "Customer" : c.channel === "call" ? "Call" : "Zoe"}: ${(c.body ?? "").slice(0, 300)}`)
    .join("\n");
  const parts = [
    `Today: ${today}`,
    `Goodshuffle status: ${b.statusLabel}`,
    b.quoteSentDate ? `Quote sent: ${b.quoteSentDate}` : "",
    b.clientNotes ? `Client note: ${b.clientNotes.slice(0, 600)}` : "",
    b.internalNotes ? `Activity log (dated notes of calls/texts/emails):\n${b.internalNotes.slice(0, 3000)}` : "",
    comms ? `Recent messages (oldest→newest):\n${comms}` : "",
  ].filter(Boolean).join("\n\n");

  const r = await chat([{ role: "system", content: CONTEXT_SYSTEM }, { role: "user", content: parts }], { json: true, temperature: 0, timeoutMs: 40000, model: process.env.COACH_MODEL?.trim() || undefined });
  let resolved = base;
  if (r.ok && r.text) {
    try {
      const p = extractJson(r.text) as { state?: unknown; confidence?: unknown; evidence?: unknown; reason?: unknown };
      const state = CONTEXT_STATES.includes(p.state as CustomerState) ? (p.state as CustomerState) : base.state;
      const confidence = typeof p.confidence === "number" ? Math.min(1, Math.max(0, p.confidence)) : 0.6;
      const evidence = typeof p.evidence === "string" && p.evidence.trim() ? p.evidence.trim() : base.evidence;
      const reason = typeof p.reason === "string" && p.reason.trim() ? `INFERENCE (from notes + messages): ${p.reason.trim()}` : base.reason;
      resolved = { state, confidence, evidence, source: "notes", reason };
    } catch {
      /* keep deterministic */
    }
  }
  upsertCustomerState({ leadId, state: resolved.state, confidence: resolved.confidence, evidence: resolved.evidence, source: resolved.source, reason: resolved.reason });
  return resolved;
}

/** Persist a resolved state only when it meaningfully changed (state or source), preserving the
 *  prior state as previous_state for the transition trail. */
function storeIfChanged(leadId: string, resolved: ResolvedState): ResolvedState {
  const prior = getCustomerState(leadId);
  if (!prior || prior.state !== resolved.state || prior.source !== resolved.source) {
    upsertCustomerState({ leadId, state: resolved.state, confidence: resolved.confidence, evidence: resolved.evidence, source: resolved.source, reason: resolved.reason });
  }
  return resolved;
}
