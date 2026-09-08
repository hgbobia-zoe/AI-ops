// Call-sentiment orchestration: take a parsed OpenPhone call event, record it, obtain the best text
// we can (transcript preferred, then AI summary), judge the customer's tone (Ollama-first, heuristic
// fallback), and — only when the customer is genuinely frustrated — post ONE alert to the dedicated
// customer-alerts Slack channel. Idempotent: one alert per call, ever.

import {
  insertCallEventIfNew,
  getCallEventByProviderId,
  updateCallContent,
  setCallSentiment,
  markCallAlerted,
  markCallNoteLogged,
  getBookingByPhoneDigits,
  insertCommsEventIfNew,
  enqueueGsOp,
  type CallEventInput,
} from "@/lib/db/repo";
import { analyzeSentiment } from "./sentiment";
import { getCallTranscript, getCallSummary, openphoneUserInitials } from "./openphone";
import { slackNotifyAlert } from "@/lib/notify/slack";
import { decideCallNote } from "@/lib/salesos/callNote";
import { initialsOf, salesOsNoteLine } from "@/lib/salesos/noteFormat";
import { logSalesEventBy } from "@/lib/salesos/audit";
import { resolveAndStore } from "@/lib/salesos/stateService";
import { todayInOpsTz } from "@/lib/dates";

export interface IngestCallInput extends CallEventInput {
  callId: string; // OpenPhone call id — the idempotency key across a call's several webhook events
  agentUserId?: string; // Quo user id of who handled the call (mapped to initials — the reliable source)
  agentName?: string; // fallback name, if the event carries one instead of an id
}

const last10 = (phone?: string | null): string | null => {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/** Log this call to the matching project's Goodshuffle notes (conversation summary, or a brief
 *  voicemail line). Independent of sentiment, once per call, and only when we can match the number.
 *  The rep initials come from Quo's user id (who handled the call) — the reliable source — else name. */
async function maybeLogCallNote(rowId: string, input: IngestCallInput, alreadyLogged: boolean, summary: string | null): Promise<void> {
  if (alreadyLogged) return;
  const comment = decideCallNote({
    eventType: input.eventType ?? "",
    direction: input.direction ?? null,
    durationSec: input.durationSec ?? null,
    summary,
  });
  if (!comment) return;
  const custPhone = input.direction === "outgoing" ? input.toPhone : input.fromPhone;
  const digits = last10(custPhone);
  const booking = digits ? getBookingByPhoneDigits(digits) : null;
  if (!booking) return; // can't attach a note to a project we can't identify
  const initials = (await openphoneUserInitials(input.agentUserId)) ?? initialsOf(input.agentName ?? null);
  const line = salesOsNoteLine(initials, comment, todayInOpsTz());
  enqueueGsOp({ op: "note_append", transactionId: booking.bookingId, label: "call logged", payload: { line } });
  markCallNoteLogged(rowId);
  // Sales audit trail: the call, attributed to the Quo rep who handled it.
  logSalesEventBy("CALL_LOGGED", booking.bookingId, initials ?? "Quo", { outcome: comment, direction: input.direction ?? "unknown" });
}

export interface IngestResult {
  recorded: boolean;
  analyzed: boolean;
  alerted: boolean;
  sentiment?: string;
  skippedReason?: string;
}

function fmtPhoneName(name: string | null | undefined, phone: string | null | undefined): string {
  const n = (name ?? "").trim();
  const p = (phone ?? "").trim();
  if (n && p) return `${n} (${p})`;
  return n || p || "unknown caller";
}

/** Record a call event and, if the customer sounds frustrated, alert Slack once. Safe to call for
 *  every webhook delivery — deduped on the call id, and it never alerts a call twice. */
export async function ingestCallEvent(input: IngestCallInput): Promise<IngestResult> {
  const callId = input.callId;
  if (!callId) return { recorded: false, analyzed: false, alerted: false, skippedReason: "no call id" };

  // Upsert one row per call. First event inserts; later events (transcript/summary) update it.
  const record: CallEventInput = { ...input, providerId: callId };
  let id = insertCallEventIfNew(record);
  const existing = id ? null : getCallEventByProviderId(callId);
  if (!id && existing) id = existing.id;
  if (!id) return { recorded: false, analyzed: false, alerted: false, skippedReason: "insert failed" };

  // Already alerted on a prior event for this call — nothing more to do.
  if (existing?.alertedAt) return { recorded: true, analyzed: true, alerted: false, skippedReason: "already alerted" };

  // Obtain the best available text: payload transcript → fetched transcript → payload/fetched summary.
  let transcript = (input.transcript ?? "").trim() || null;
  if (!transcript) transcript = await getCallTranscript(callId);
  let summary = (input.summary ?? "").trim() || null;
  if (!transcript && !summary) summary = await getCallSummary(callId);
  updateCallContent(id, { transcript, summary, durationSec: input.durationSec ?? null, contactName: input.contactName, eventType: input.eventType });

  // Log the call to Goodshuffle notes (conversation summary or voicemail) — regardless of sentiment.
  await maybeLogCallNote(id, input, !!existing?.noteLoggedAt, summary);

  const text = transcript ?? summary;
  if (!text) return { recorded: true, analyzed: false, alerted: false, skippedReason: "no transcript/summary yet" };

  const s = await analyzeSentiment(text);
  setCallSentiment(id, { sentiment: s.label, score: s.score, method: s.method, reasons: s.reasons, llmModel: s.llmModel });
  if (!s.isNegative) return { recorded: true, analyzed: true, alerted: false, sentiment: s.label };

  // Frustrated customer → alert the dedicated channel, once.
  const who = fmtPhoneName(input.contactName, input.direction === "outgoing" ? input.toPhone : input.fromPhone);
  const confidence = Math.round(s.score * 100);
  const conf = s.method === "llm" ? `${confidence}% (LLM${s.llmModel ? ` · ${s.llmModel}` : ""})` : `${confidence}% (keyword heuristic — no transcript LLM read)`;
  const reasons = s.reasons.length ? `\n> ${s.reasons.join(" · ")}` : "";
  const src = transcript ? "transcript" : "AI summary";
  const msg =
    `:rotating_light: *Frustrated caller* — ${who}\n` +
    `Negative tone on a ${input.direction === "outgoing" ? "call we made" : "call in"} (from the ${src}). Confidence ${conf}.${reasons}\n` +
    `_Review the call in OpenPhone and consider a follow-up._`;

  const res = await slackNotifyAlert(msg);
  if (res.ok) markCallAlerted(id);
  return { recorded: true, analyzed: true, alerted: res.ok, sentiment: s.label, skippedReason: res.ok ? undefined : res.skipped ? "alert channel not configured" : res.error };
}

export interface InboundSmsInput {
  providerId: string; // OpenPhone message id (idempotency)
  from: string; // customer number
  to?: string | null; // our Quo number
  body: string;
  occurredAt?: string | null;
}

export interface InboundSmsResult {
  recorded: boolean;
  leadId: string | null;
  duplicate?: boolean;
}

/** Ingest an inbound customer SMS: store it on the unified timeline, match it to a lead, and log a
 *  CUSTOMER_REPLIED audit entry. Interpretation (state/next-action) is a later phase — this just
 *  captures the reply faithfully (FACT), never inventing meaning. Idempotent on the message id. */
export function ingestInboundSms(input: InboundSmsInput): InboundSmsResult {
  const digits = last10(input.from);
  const lead = digits ? getBookingByPhoneDigits(digits) : null;
  const leadId = lead?.bookingId ?? null;

  const id = insertCommsEventIfNew({
    providerId: input.providerId,
    leadId,
    direction: "inbound",
    channel: "sms",
    fromPhone: input.from,
    toPhone: input.to ?? null,
    body: input.body,
    occurredAt: input.occurredAt ?? null,
  });
  if (!id) return { recorded: false, leadId, duplicate: true };

  if (leadId) {
    logSalesEventBy("INBOUND_SMS", leadId, "Customer", { preview: input.body.slice(0, 140) });
    // Customer responded → re-resolve the state (AI classifies the reply). Best-effort, non-blocking.
    void resolveAndStore(leadId).catch(() => {});
  }
  return { recorded: true, leadId };
}
