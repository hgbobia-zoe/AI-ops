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

export const SMS_MAX_LEN = 1000;
const DEDUPE_MS = 120_000;

export interface LeadSmsResult {
  ok: boolean;
  disabled?: boolean; //  SMS_SEND_ENABLED is off — nothing was sent (never a fake success)
  duplicate?: boolean; // identical text to the same number within the dedupe window — not re-sent
  skipped?: boolean; //   the active provider is not configured
  providerMsgId?: string | null;
  error?: string;
}

/** Send one reviewed outreach text to a lead through the active phone provider. The number is always the
 *  lead's own phone on file (never a caller-supplied recipient). Gated by SMS_SEND_ENABLED exactly like
 *  the route. `userId` attributes the message to a Quo rep; `initials` label the note/audit/timeline. */
export async function sendLeadSms(input: { id: string; body: string; userId?: string; initials?: string | null; edited?: boolean }): Promise<LeadSmsResult> {
  if (process.env.SMS_SEND_ENABLED !== "true") {
    return { ok: false, disabled: true, error: "SMS sending is off — set SMS_SEND_ENABLED=true to enable." };
  }
  const id = (input.id ?? "").trim();
  const text = (input.body ?? "").trim();
  if (!id) return { ok: false, error: "id required" };
  if (!text) return { ok: false, error: "message body required" };
  if (text.length > SMS_MAX_LEN) return { ok: false, error: `message too long (max ${SMS_MAX_LEN})` };

  const lead = getBookingById(id);
  if (!lead) return { ok: false, error: "lead not found" };
  const phone = (lead.clientPhone ?? "").trim();
  if (!phone) return { ok: false, error: "No phone number on file for this lead." };

  // Idempotency — never double-text the same message in quick succession.
  if (smsRecentlySent(phone, text, new Date(Date.now() - DEDUPE_MS).toISOString())) {
    return { ok: true, duplicate: true };
  }

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
    return { ok: true, providerMsgId: res.providerMsgId };
  }
  return { ok: false, error: res.error ?? "send failed", skipped: res.skipped };
}
