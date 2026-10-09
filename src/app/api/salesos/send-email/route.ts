// Send a reviewed follow-up EMAIL that continues the lead's Goodshuffle client email thread.
// CUSTOMER-FACING: the rep drafts/edits the body and clicks Send (per-message human approval). The
// server can't call Goodshuffle directly (Cloudflare), so this QUEUES an `email_send` op; the office
// Auto-Pull session drains it by reading the project's message thread and POSTing /app/conversation/
// sendMessage as a reply (Goodshuffle appends the signature). Master-switched off until EMAIL_SEND_ENABLED
// = "true", matching SMS. Nothing is auto-sent: a human drafts, reviews, and confirms each one.

import { NextResponse } from "next/server";
import { getBookingById, enqueueGsOp } from "@/lib/db/repo";
import { logSalesEvent } from "@/lib/salesos/audit";
import { viewerInitials } from "@/lib/auth/getSession";
import { syncTouchpointNote, shortHash } from "@/lib/comms/noteSync";
import { todayInOpsTz } from "@/lib/dates";

export const dynamic = "force-dynamic";

const MAX_LEN = 8000;

/** Turn the rep's plain-text draft into the simple <div>-per-line HTML Goodshuffle's editor produces.
 *  (If the body already looks like HTML, pass it through untouched.) */
function toHtml(text: string): string {
  if (/<\w+[^>]*>/.test(text)) return text;
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n/)
    .map((line) => (line.trim() === "" ? "<div><br></div>" : `<div>${esc(line)}</div>`))
    .join("");
}

export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.EMAIL_SEND_ENABLED !== "true") {
    return NextResponse.json({ ok: false, disabled: true, error: "Email sending is off — set EMAIL_SEND_ENABLED=true to enable." });
  }

  let body: { id?: string; content?: string; subject?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  const text = (body.content ?? "").trim();
  const subject = (body.subject ?? "").trim() || undefined;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!text) return NextResponse.json({ error: "message body required" }, { status: 400 });
  if (text.length > MAX_LEN) return NextResponse.json({ error: `message too long (max ${MAX_LEN})` }, { status: 400 });

  const lead = getBookingById(id);
  if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 });

  // Queue the reply for the logged-in office session to replay into the GS thread.
  enqueueGsOp({ op: "email_send", transactionId: id, label: "email reply", payload: { content: toHtml(text), subject } });
  await logSalesEvent("EMAIL_SENT", id, { chars: text.length, queued: true });

  // Auto-log the outreach into the project's INTERNAL notes (gated behind GS_NOTE_SYNC_ENABLED, deduped
  // per send) so the team has a complete reach-out trail without hand-logging it.
  try {
    const initials = await viewerInitials();
    syncTouchpointNote({
      kind: "email",
      emailKey: `${id}:${shortHash(`${subject ?? ""}\n${text}`)}`,
      transactionId: id,
      repInitials: initials,
      clientName: lead.clientName,
      subject: subject ?? null,
      dateYmd: todayInOpsTz(),
    });
  } catch {
    /* note is best-effort — never fail the send over it */
  }

  return NextResponse.json({ ok: true, queued: true, message: "Queued — it sends on the next Auto-Pull cycle from the office machine." });
}
