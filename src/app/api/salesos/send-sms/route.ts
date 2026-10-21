// Send a reviewed outreach text to a lead via Quo (OpenPhone). CUSTOMER-FACING: the rep drafts/edits
// the copy and clicks Send (per-message human approval). The actual send (gate SMS_SEND_ENABLED, dedupe,
// provider call, messages/note/audit/timeline logging) lives in the shared sendLeadSms helper, which the
// bulk Review-and-Fire panel reuses so both go through the one sanctioned gated path. This route resolves
// the sender attribution from the session, then delegates.

import { NextResponse } from "next/server";
import { getBookingById } from "@/lib/db/repo";
import { sendLeadSms, SMS_MAX_LEN } from "@/lib/salesos/smsSend";
import { viewerInitials, viewerQuoUserId, authEnabled } from "@/lib/auth/getSession";
import { openphoneUserInitials } from "@/lib/comms/openphone";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.SMS_SEND_ENABLED !== "true") {
    return NextResponse.json({ ok: false, disabled: true, error: "SMS sending is off — set SMS_SEND_ENABLED=true to enable." });
  }

  let body: { id?: string; body?: string; userId?: string; edited?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  const text = (body.body ?? "").trim();
  // Sender attribution — NO impersonation. With per-user login on, a rep can ONLY send as themselves:
  // the sender is always their own linked Quo user (a client-supplied userId is ignored). Falls back to
  // the shared SalesOS number if they haven't linked a Quo account. Only when login is off (single
  // operator) does an explicit userId apply.
  const linkedQuo = (await viewerQuoUserId()) || undefined;
  const userId = authEnabled() ? linkedQuo : ((body.userId ?? "").trim() || linkedQuo || undefined);
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!text) return NextResponse.json({ error: "message body required" }, { status: 400 });
  if (text.length > SMS_MAX_LEN) return NextResponse.json({ error: `message too long (max ${SMS_MAX_LEN})` }, { status: 400 });

  const lead = getBookingById(id);
  if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 });
  if (!(lead.clientPhone ?? "").trim()) return NextResponse.json({ ok: false, error: "No phone number on file for this lead." });

  // Initials: the picked Quo rep first (Quo's own record matches), then the signed-in user, else "Zoe team".
  const initials = (userId ? await openphoneUserInitials(userId) : null) ?? (await viewerInitials());
  const res = await sendLeadSms({ id, body: text, userId, initials, edited: Boolean(body.edited) });

  if (res.ok && res.duplicate) return NextResponse.json({ ok: true, duplicate: true, message: "That exact text was just sent — not sending again." });
  if (res.ok) return NextResponse.json({ ok: true, providerMsgId: res.providerMsgId });
  return NextResponse.json({ ok: false, error: res.error ?? "send failed", skipped: res.skipped });
}
