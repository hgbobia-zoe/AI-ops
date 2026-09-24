// The CONTEXT ENGINE — the trusted intermediary between telephony (Quo/Sona) and Zoe's data. Given a
// phone number (or a stored call), it resolves WHO is calling with explicit confidence, then assembles a
// Context Pack of ONLY verified facts pulled from the existing models (bookings, dispatch stops, comms
// timeline, the Event Risk engine). RULES CALCULATE here; nothing is invented. Where a fact is absent
// the pack says so (null / UNAVAILABLE) and a human-readable caveat is added to `notes`.

import {
  getBookingById,
  getBookingByPhoneDigits,
  getCommsForLead,
  getCustomerCallThread,
  resolveCallerName,
  type BookingView,
  type CallEventView,
} from "@/lib/db/repo";
import { getRiskQueue } from "@/lib/risk/store";
import { ourPhoneDigits, fmtPhone } from "./identity";
import { getOpenphoneContactMap } from "./openphone";
import {
  findIdentityMatchesByPhone,
  getLogisticsByPhone,
  getOpenIssuesForBooking,
} from "./store";
import { allowedActionNames } from "./toolRegistry";
import type {
  CallerIdentity,
  ContextPack,
  ContextEventRef,
  ContextInteraction,
  ContextOrder,
  ContextQuote,
  ContextRisk,
  IdentityConfidence,
  TranscriptTurn,
} from "./types";

const last10 = (p: string | null | undefined): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/** Resolve caller identity from a phone number. Confidence is a RULE, never a guess: 0 matches =
 *  UNKNOWN, exactly 1 = CONFIRMED, ≥2 = MULTIPLE_MATCHES (the operator must disambiguate). */
export function resolveCallerIdentity(phone: string | null, opts: { contactName?: string | null } = {}): CallerIdentity {
  const digits = last10(phone);
  const matches = digits ? findIdentityMatchesByPhone(digits) : [];
  let confidence: IdentityConfidence;
  let reason: string;
  if (matches.length === 0) {
    confidence = "UNKNOWN";
    reason = digits ? "No booking on file matches this number." : "No caller number available to match.";
  } else if (matches.length === 1) {
    confidence = "CONFIRMED";
    reason = "Exactly one booking matches this number.";
  } else {
    confidence = "MULTIPLE_MATCHES";
    reason = `${matches.length} bookings share this number — confirm which customer before acting.`;
  }
  const displayName =
    (opts.contactName ?? "").trim() ||
    matches[0]?.name ||
    fmtPhone(phone) ||
    "Unknown caller";
  return { phone: phone ?? null, phoneDigits: digits, displayName, confidence, matches, reason };
}

function toEventRef(b: BookingView): ContextEventRef {
  return { bookingId: b.bookingId, name: b.eventName || "Untitled event", eventDate: b.eventDate, status: b.statusLabel, signed: b.signed, venue: b.venue, location: b.location };
}
function toQuote(b: BookingView): ContextQuote {
  return { bookingId: b.bookingId, name: b.eventName || "Untitled event", eventDate: b.eventDate, status: b.statusLabel, total: b.grandTotal, quoteSentDate: b.quoteSentDate, amountDue: b.amountDue };
}
function toOrder(b: BookingView): ContextOrder {
  return { bookingId: b.bookingId, name: b.eventName || "Untitled event", eventDate: b.eventDate, total: b.grandTotal, amountPaid: b.amountPaid, amountDue: b.amountDue, signed: b.signed, lineItems: b.lineItems };
}

/** Build the Context Pack for a caller. Optionally anchor to a specific booking (when the operator has
 *  disambiguated a MULTIPLE_MATCHES caller). Everything is derived from existing data; empty/absent
 *  facts are represented honestly. */
export async function buildContextPack(
  phone: string | null,
  opts: { contactName?: string | null; anchorBookingId?: string | null } = {},
): Promise<ContextPack> {
  const identity = resolveCallerIdentity(phone, { contactName: opts.contactName });
  const notes: string[] = [];

  // The bookings we can stand behind for this caller: the anchored one if given, else every match.
  const ids = new Set<string>();
  if (opts.anchorBookingId) ids.add(opts.anchorBookingId);
  for (const m of identity.matches) ids.add(m.bookingId);
  const bookings: BookingView[] = [];
  for (const id of ids) {
    const b = getBookingById(id);
    if (b) bookings.push(b);
  }
  bookings.sort((a, b) => (b.eventDate ?? "").localeCompare(a.eventDate ?? ""));

  const primary = opts.anchorBookingId ? getBookingById(opts.anchorBookingId) : bookings[0] ?? null;
  const customer = primary
    ? { bookingId: primary.bookingId, name: primary.clientName || identity.displayName, email: primary.clientEmail || null, phone: primary.clientPhone || phone }
    : null;
  if (!customer) notes.push("Caller not matched to any customer — identity UNKNOWN, treat all details as unverified.");

  const events: ContextEventRef[] = bookings.map(toEventRef);
  const activeQuotes: ContextQuote[] = bookings.filter((b) => !b.signed).map(toQuote);
  const orders: ContextOrder[] = bookings.filter((b) => b.signed).map(toOrder);

  // Delivery / pickup from the dispatch layer, matched by phone. Honest UNAVAILABLE when no stop exists.
  const { delivery, pickup } = getLogisticsByPhone(customer?.phone ?? phone);
  if (delivery.availability === "UNAVAILABLE") notes.push("Delivery status Unavailable — no matching stop on any dispatch route.");
  if (pickup.availability === "UNAVAILABLE") notes.push("Pickup status Unavailable — no matching stop on any dispatch route.");

  // Open items: post-event service-recovery issues + any outstanding balance (both are real facts).
  const openIssues: { source: string; label: string; detail: string | null }[] = [];
  for (const b of bookings) {
    for (const iss of getOpenIssuesForBooking(b.bookingId)) openIssues.push({ source: "post-event", label: iss.label, detail: iss.detail });
    if (b.amountDue != null && b.amountDue > 0) openIssues.push({ source: "billing", label: `Balance due on ${b.eventName || b.bookingId}`, detail: null });
  }

  // Recent interactions: the matched customer's texts + call thread, merged newest-first.
  const recentInteractions = await buildRecentInteractions(primary, customer?.phone ?? phone);

  // Operational risk: open risks on the caller's events, from the Event Risk engine (never fabricated).
  const riskByEvent = getRiskQueue();
  const eventIdSet = new Set(bookings.map((b) => b.bookingId));
  const operationalRisk: ContextRisk[] = riskByEvent
    .filter((r) => r.eventId && eventIdSet.has(r.eventId) && (r.status === "OPEN" || r.status === "ACKNOWLEDGED" || r.status === "IN_PROGRESS"))
    .map((r) => ({ severity: r.severity, title: r.title, date: r.date ?? null, category: r.category }));

  return {
    generatedAt: new Date().toISOString(),
    caller: identity,
    customer,
    events,
    activeQuotes,
    orders,
    delivery,
    pickup,
    openIssues,
    recentInteractions,
    operationalRisk,
    allowedActions: allowedActionNames(),
    notes,
  };
}

async function buildRecentInteractions(primary: BookingView | null, phone: string | null): Promise<ContextInteraction[]> {
  const out: ContextInteraction[] = [];
  if (primary) {
    for (const c of getCommsForLead(primary.bookingId, 20)) {
      out.push({ channel: c.channel, direction: c.direction, when: c.occurredAt ?? c.ts, preview: (c.body ?? "").slice(0, 160), actor: c.actor });
    }
  }
  const digits = last10(phone);
  if (digits) {
    const ourDigits = ourPhoneDigits();
    const contactMap = await getOpenphoneContactMap().catch(() => new Map<string, string>());
    for (const call of getCustomerCallThread(digits, { ourDigits, contactMap, limit: 12 })) {
      out.push({
        channel: "call",
        direction: call.direction === "outgoing" ? "outbound" : "inbound",
        when: call.occurredAt ?? call.ts,
        preview: call.sentiment ? `Call (${call.sentiment})` : "Call",
        actor: null,
      });
    }
  }
  out.sort((a, b) => (Date.parse(b.when ?? "") || 0) - (Date.parse(a.when ?? "") || 0));
  return out.slice(0, 10);
}

// ── Transcript parsing ─────────────────────────────────────────────────────────────────────────────
// OpenPhone transcripts are "identifier: text" lines where the identifier is a phone number. We label a
// line REP when the number is one of Zoe's, CUSTOMER otherwise; an explicit SONA/AI/AGENT tag maps to
// SONA (for when the AI agent is on the line). Returns null when there is genuinely no transcript — the
// UI then shows "Transcript unavailable" rather than anything fabricated.
export function parseTranscript(raw: string | null | undefined, ourDigits: Set<string>): TranscriptTurn[] | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const turns: TranscriptTurn[] = [];
  for (const line of lines) {
    const m = line.match(/^([^:]{1,40}):\s*(.*)$/);
    if (!m) {
      turns.push({ speaker: "UNKNOWN", raw: "", text: line });
      continue;
    }
    const label = m[1].trim();
    const body = m[2].trim();
    const d = last10(label);
    let speaker: TranscriptTurn["speaker"];
    if (/\b(sona|ai|agent|assistant)\b/i.test(label)) speaker = "SONA";
    else if (d && ourDigits.has(d)) speaker = "REP";
    else if (d) speaker = "CUSTOMER";
    else speaker = "UNKNOWN";
    turns.push({ speaker, raw: label, text: body });
  }
  return turns.length ? turns : null;
}

/** The best text we have for a call, for reason classification + summaries: summary preferred, then
 *  transcript. Never fabricates. */
export function callText(call: CallEventView): string | null {
  return (call.summary ?? "").trim() || (call.transcript ?? "").trim() || null;
}

/** Resolve a display name for a call's counterparty, reusing the repo's rule (Quo contact → matched
 *  booking → phone). */
export function callerNameFor(call: CallEventView): string {
  return (call.contactName?.trim() || resolveCallerName(call) || fmtPhone(call.direction === "outgoing" ? call.toPhone : call.fromPhone)) ?? "Unknown caller";
}

/** The customer's phone on a call (the party that isn't one of Zoe's numbers). */
export function customerPhoneOf(call: CallEventView, ourDigits: Set<string>): string | null {
  const fromD = last10(call.fromPhone);
  const toD = last10(call.toPhone);
  if (fromD && !ourDigits.has(fromD)) return call.fromPhone;
  if (toD && !ourDigits.has(toD)) return call.toPhone;
  return call.direction === "outgoing" ? call.toPhone : call.fromPhone;
}

// Re-export so callers have a single import site for booking lookup by phone (used by the queue).
export { getBookingByPhoneDigits };
