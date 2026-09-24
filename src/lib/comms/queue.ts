// The Communications QUEUE + call-detail assembly. Reuses the live call_events feed (populated by the
// OpenPhone/Quo webhook) and the SMS timeline, enriches each row with the calculated call reason, the
// matched customer/event, identity confidence, and open operational risk. RULES CALCULATE: handled-by,
// status and disposition are DERIVED honestly from what we actually recorded — we never invent that a
// call was "resolved" or "handled by AI" (Sona is not connected, so no row is ever AI-handled yet).

import { getRecentCallEvents, getCallEventById, type CallEventView } from "@/lib/db/repo";
import { getRiskQueue } from "@/lib/risk/store";
import { ourPhoneDigits, fmtPhone } from "./identity";
import { classifyReason, REASON_DESK, type CallReason, type ReasonDesk } from "./reasons";
import { getAllReasonOverrides, getReasonOverride, getRecentSmsEvents } from "./store";
import {
  buildContextPack,
  parseTranscript,
  callText,
  callerNameFor,
  customerPhoneOf,
  getBookingByPhoneDigits,
} from "./context";
import { buildHandoffBrief } from "./handoff";
import type {
  QueueRow,
  CallCard,
  HandledBy,
  CallStatus,
  Disposition,
} from "./types";

const last10 = (p: string | null | undefined): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/** Derive how a call was handled from what we recorded. Sona is NOT connected, so no real row is ever
 *  AI-handled; a call with talk time was handled by a human, otherwise it's UNKNOWN (missed/voicemail). */
function deriveHandledBy(call: CallEventView): HandledBy {
  if ((call.durationSec ?? 0) > 0) return "HUMAN";
  return "UNKNOWN";
}

function deriveStatus(call: CallEventView): CallStatus {
  const et = (call.eventType ?? "").toLowerCase();
  if (et.includes("missed") || et.includes("no-answer")) return "MISSED";
  if ((call.durationSec ?? 0) > 0 || call.transcript || call.summary) return "COMPLETED";
  if (et.includes("voicemail")) return "VOICEMAIL";
  return "MISSED";
}

/** Disposition is only asserted where we actually know it: an escalation is KNOWN when the frustrated-
 *  caller alert fired. We never fabricate "RESOLVED" — unknown stays UNKNOWN. */
function deriveDisposition(call: CallEventView): Disposition {
  if (call.alertedAt) return "ESCALATED";
  return "UNKNOWN";
}

function riskCountFor(bookingId: string | null, riskEventIds: Map<string, number>): number {
  return bookingId ? riskEventIds.get(bookingId) ?? 0 : 0;
}

/** Open-risk counts per event id, computed once for the whole queue. */
function openRiskCounts(): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of getRiskQueue()) {
    if (!r.eventId) continue;
    if (r.status !== "OPEN" && r.status !== "ACKNOWLEDGED" && r.status !== "IN_PROGRESS") continue;
    m.set(r.eventId, (m.get(r.eventId) ?? 0) + 1);
  }
  return m;
}

function callToRow(call: CallEventView, ourDigits: Set<string>, overrides: Map<string, CallReason>, riskCounts: Map<string, number>): QueueRow {
  const custPhone = customerPhoneOf(call, ourDigits);
  const digits = last10(custPhone);
  const booking = digits ? getBookingByPhoneDigits(digits) : null;
  const calc = classifyReason(callText(call));
  const override = overrides.get(call.id);
  const reason: CallReason = override ?? calc.reason;
  const identityConfidence = booking ? "CONFIRMED" : digits ? "UNKNOWN" : "UNKNOWN";
  return {
    id: call.id,
    providerId: call.providerId,
    occurredAt: call.occurredAt,
    ts: call.ts,
    direction: (call.direction as "incoming" | "outgoing" | null) ?? null,
    callerName: callerNameFor(call),
    callerPhone: custPhone,
    customerName: booking?.clientName?.trim() || null,
    customerId: booking?.bookingId ?? null,
    eventName: booking?.eventName?.trim() || null,
    eventDate: booking?.eventDate ?? null,
    reason,
    reasonConfidence: override ? 1 : calc.confidence,
    reasonMethod: override ? "human" : "heuristic",
    channel: "call",
    handledBy: deriveHandledBy(call),
    status: deriveStatus(call),
    disposition: deriveDisposition(call),
    sentiment: call.sentiment,
    identityConfidence,
    durationSec: call.durationSec,
    riskCount: riskCountFor(booking?.bookingId ?? null, riskCounts),
  };
}

/** The unified recent-communications queue: calls (from call_events) + SMS (from the timeline), newest
 *  first. Real rows only. */
export function buildQueue(limit = 80): QueueRow[] {
  const ourDigits = ourPhoneDigits();
  const overrides = getAllReasonOverrides();
  const riskCounts = openRiskCounts();

  const callRows = getRecentCallEvents(limit).map((c) => callToRow(c, ourDigits, overrides, riskCounts));

  const smsRows: QueueRow[] = getRecentSmsEvents(Math.min(limit, 60)).map((m) => {
    const custPhone = m.direction === "inbound" ? m.fromPhone : m.toPhone;
    const digits = last10(custPhone);
    const booking = digits ? getBookingByPhoneDigits(digits) : null;
    const calc = classifyReason(m.body);
    return {
      id: m.id,
      providerId: m.providerId,
      occurredAt: m.occurredAt,
      ts: m.ts,
      direction: m.direction === "outbound" ? "outgoing" : "incoming",
      callerName: booking?.clientName?.trim() || fmtPhone(custPhone) || "Unknown",
      callerPhone: custPhone,
      customerName: booking?.clientName?.trim() || null,
      customerId: booking?.bookingId ?? null,
      eventName: booking?.eventName?.trim() || null,
      eventDate: booking?.eventDate ?? null,
      reason: calc.reason,
      reasonConfidence: calc.confidence,
      reasonMethod: "heuristic",
      channel: "sms",
      handledBy: m.direction === "outbound" ? "HUMAN" : "UNKNOWN",
      status: "COMPLETED",
      disposition: "UNKNOWN",
      sentiment: null,
      identityConfidence: booking ? "CONFIRMED" : "UNKNOWN",
      durationSec: null,
      riskCount: booking ? riskCounts.get(booking.bookingId) ?? 0 : 0,
    };
  });

  return [...callRows, ...smsRows].sort((a, b) => (Date.parse(b.occurredAt ?? b.ts) || 0) - (Date.parse(a.occurredAt ?? a.ts) || 0)).slice(0, limit);
}

export function deskOf(reason: CallReason): ReasonDesk {
  return REASON_DESK[reason];
}

/** Full detail for one call (side-panel): the enriched row, the parsed transcript, the summary, the
 *  actions we actually recorded, the Context Pack, and a handoff brief when the call was escalated. */
export async function buildCallCard(callId: string): Promise<CallCard | null> {
  const call = getCallEventById(callId);
  if (!call) return null;
  const ourDigits = ourPhoneDigits();
  const overrides = new Map<string, CallReason>();
  const ov = getReasonOverride(callId);
  if (ov) overrides.set(callId, ov.reason);
  const row = callToRow(call, ourDigits, overrides, openRiskCounts());

  const transcript = parseTranscript(call.transcript, ourDigits);
  const context = await buildContextPack(row.callerPhone, { contactName: call.contactName, anchorBookingId: row.customerId });

  // Actions we actually recorded for this call (facts) — the note we logged, the alert we sent.
  const actionsTaken: { label: string; detail: string | null; ts: string | null }[] = [];
  if (call.noteLoggedAt) actionsTaken.push({ label: "Call logged to Goodshuffle notes", detail: null, ts: call.noteLoggedAt });
  if (call.alertedAt) actionsTaken.push({ label: "Frustrated-caller alert sent to Slack", detail: call.reasons.join(" · ") || null, ts: call.alertedAt });

  const handoff = row.disposition === "ESCALATED" ? buildHandoffBrief(context, row.reason, { summary: call.summary }) : null;

  return { row, transcript, summary: call.summary, actionsTaken, context, handoff };
}
