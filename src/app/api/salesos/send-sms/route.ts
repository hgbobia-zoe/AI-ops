// Send a reviewed outreach text to a lead via Quo (OpenPhone). CUSTOMER-FACING: the rep drafts/edits
// the copy and clicks Send (per-message human approval). Two guardrails on top of that:
//   • SMS_SEND_ENABLED must be "true" — a deliberate master switch, so nothing goes out until it's on.
//   • an identical text to the same number within 2 minutes is treated as a duplicate (no re-send).
// The number is always the lead's own phone on file (never a caller-supplied recipient). Every send is
// logged to the messages table.

import { NextResponse } from "next/server";
import { getBookingById, insertMessage, smsRecentlySent, enqueueGsOp } from "@/lib/db/repo";
import { sendSms } from "@/lib/notify/sms";
import { getSettings } from "@/lib/settings";
import { viewerInitials, viewerQuoUserId } from "@/lib/auth/getSession";
import { openphoneUserInitials } from "@/lib/comms/openphone";
import { salesOsNoteLine } from "@/lib/salesos/noteFormat";
import { todayInOpsTz } from "@/lib/dates";

export const dynamic = "force-dynamic";

const MAX_LEN = 1000;
const DEDUPE_MS = 120_000;

export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.SMS_SEND_ENABLED !== "true") {
    return NextResponse.json({ ok: false, disabled: true, error: "SMS sending is off — set SMS_SEND_ENABLED=true to enable." });
  }

  let body: { id?: string; body?: string; userId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  const text = (body.body ?? "").trim();
  // Sender attribution: an explicit "Send as" pick wins; otherwise the signed-in rep's linked Quo user
  // (so a logged-in rep is attributed automatically, no picker needed).
  const userId = (body.userId ?? "").trim() || (await viewerQuoUserId()) || undefined;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!text) return NextResponse.json({ error: "message body required" }, { status: 400 });
  if (text.length > MAX_LEN) return NextResponse.json({ error: `message too long (max ${MAX_LEN})` }, { status: 400 });

  const lead = getBookingById(id);
  if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 });
  const phone = (lead.clientPhone ?? "").trim();
  if (!phone) return NextResponse.json({ ok: false, error: "No phone number on file for this lead." });

  // Idempotency — never double-text the same message.
  if (smsRecentlySent(phone, text, new Date(Date.now() - DEDUPE_MS).toISOString())) {
    return NextResponse.json({ ok: true, duplicate: true, message: "That exact text was just sent — not sending again." });
  }

  const res = await sendSms(phone, text, { userId });
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
    // Log the sent text back into the Goodshuffle project notes so the comms history stays complete.
    // Queued for a logged-in session to write (the server can't call Goodshuffle directly).
    try {
      // Initials: the picked Quo rep first (Quo's own record matches), then the signed-in user, else "SalesOS".
      const initials = (userId ? await openphoneUserInitials(userId) : null) ?? (await viewerInitials());
      const line = salesOsNoteLine(initials, `Sent text: "${text}"`, todayInOpsTz());
      enqueueGsOp({ op: "note_append", transactionId: id, label: "sms sent", payload: { line } });
    } catch {
      /* note is best-effort — never fail the send over it */
    }
    return NextResponse.json({ ok: true, providerMsgId: res.providerMsgId });
  }
  return NextResponse.json({ ok: false, error: res.error ?? "send failed", skipped: res.skipped });
}
