// The app's sanctioned live SMS sender, factored out of the /api/salesos/send-sms route so BOTH the
// single lead-panel send and the bulk Review-and-Fire panel invoke the EXACT SAME gated path — not a new
// one. It enforces SMS_SEND_ENABLED (the master switch), a short identical-text dedupe, always texts the
// lead's own number on file, logs the send to the messages table, mirrors it into the Goodshuffle
// internal note + the unified comms timeline + the sales audit trail. Never throws on a provider failure;
// returns a structured outcome the caller reflects honestly (sent / failed / held / duplicate).

import { randomUUID } from "node:crypto";
import { getBookingById, insertMessage, smsRecentlySent, insertCommsEventIfNew } from "@/lib/db/repo";
import { sendSms } from "@/lib/notify/sms";
import { getSettings } from "@/lib/settings";
import { syncTouchpointNote, shortHash } from "@/lib/comms/noteSync";
import { todayInOpsTz } from "@/lib/dates";
import { logSalesEvent } from "./audit";
import { flagOn } from "@/lib/flags";
import { isSuppressed } from "@/lib/prospecting/store";
import { appendSmsSignoff, hasSmsSignoff, stripSmsSignoff, withSmsSignoff, type SignoffOccasion } from "@/lib/comms/smsSignoff";
import { signoffHistoryFor } from "@/lib/comms/smsSignoffHistory";

export const SMS_MAX_LEN = 1000;
const DEDUPE_MS = 120_000;

export interface LeadSmsResult {
  ok: boolean;
  disabled?: boolean; //  SMS_SEND_ENABLED is off — nothing was sent (never a fake success)
  duplicate?: boolean; // identical text to the same number within the dedupe window — not re-sent
  skipped?: boolean; //   the active provider is not configured
  providerMsgId?: string | null;
  signoff?: boolean; //  the sent text carries the thank-you line
  error?: string;
}

/** Send one reviewed outreach text to a lead through the active phone provider. The number is always the
 *  lead's own phone on file (never a caller-supplied recipient). Gated by SMS_SEND_ENABLED exactly like
 *  the route. `userId` attributes the message to a Quo rep; `initials` label the note/audit/timeline.
 *  `occasion` feeds the thank-you line rule (default follow_up: added only when the thread has gone quiet). */
export async function sendLeadSms(input: { id: string; body: string; userId?: string; initials?: string | null; edited?: boolean; occasion?: SignoffOccasion }): Promise<LeadSmsResult> {
  if (!flagOn("SMS_SEND_ENABLED")) {
    return { ok: false, disabled: true, error: "SMS sending is turned off (SMS_SEND_ENABLED=false)." };
  }
  const id = (input.id ?? "").trim();
  const raw = (input.body ?? "").trim();
  if (!id) return { ok: false, error: "id required" };
  if (!raw) return { ok: false, error: "message body required" };
  if (raw.length > SMS_MAX_LEN) return { ok: false, error: `message too long (max ${SMS_MAX_LEN})` };

  const lead = getBookingById(id);
  if (!lead) return { ok: false, error: "lead not found" };
  const phone = (lead.clientPhone ?? "").trim();
  if (!phone) return { ok: false, error: "No phone number on file for this lead." };
  // The shared do-not-contact list (a texted STOP lands there too) wins over any send.
  if (isSuppressed({ phone, email: lead.clientEmail })) return { ok: false, error: "This number is on the do-not-contact list." };

  // Idempotency: never double text the same message in quick succession. Checked with and without the
  // thank-you line, because a resend seconds later sees a live thread and would drop the line.
  const dedupeSince = new Date(Date.now() - DEDUPE_MS).toISOString();
  if ([raw, stripSmsSignoff(raw), appendSmsSignoff(raw)].some((v) => v && smsRecentlySent(phone, v, dedupeSince))) {
    return { ok: true, duplicate: true };
  }

  // The thank-you line rule is applied here, at send time, with this number's real recent history: added
  // when the text starts or restarts the conversation, taken out of a quick reply or a second text today.
  // A text that would go past the length limit with the line is sent as written.
  const decided = withSmsSignoff(raw, { occasion: input.occasion ?? "follow_up", history: signoffHistoryFor(phone) });
  const text = decided && decided.length <= SMS_MAX_LEN ? decided : raw;

  const res = await sendSms(phone, text, { userId: input.userId });
  insertMessage({
    channel: "sms",
    provider: getSettings().smsProvider,
    toPhone: phone,
    body: text,
    providerMsgId: res.providerMsgId,
    status: res.ok ? "sent" : res.skipped ? "skipped" : "failed",
    error: res.error,
  });

  if (res.ok) {
    try {
      const initials = input.initials ?? null;
      syncTouchpointNote({
        kind: "text",
        messageId: res.providerMsgId || `${id}:${shortHash(text)}`,
        transactionId: id,
        repInitials: initials,
        clientName: lead.clientName,
        snippet: text,
        dateYmd: todayInOpsTz(),
      });
      await logSalesEvent("MESSAGE_SENT", id, { chars: text.length, to: phone.slice(-4), sender: initials ?? "SalesOS", edited: Boolean(input.edited) });
      insertCommsEventIfNew({ providerId: res.providerMsgId || `out-${randomUUID()}`, leadId: id, direction: "outbound", channel: "sms", toPhone: phone, body: text, actor: initials ?? "SalesOS", occurredAt: new Date().toISOString() });
    } catch {
      /* note + audit + timeline are best-effort — never fail the send over them */
    }
    return { ok: true, providerMsgId: res.providerMsgId, signoff: hasSmsSignoff(text) };
  }
  return { ok: false, error: res.error ?? "send failed", skipped: res.skipped };
}
