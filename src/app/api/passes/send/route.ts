// Text a Shift Pass link to the contractor via Quo (OpenPhone). Owner/Admin only (proxy gates
// /api/passes). Same master switch as sales outreach — SMS_SEND_ENABLED must be "true". The number is
// the one saved on the pass (or supplied with the request); the body is a plain link handoff.

import { NextResponse } from "next/server";
import { getShiftPass } from "@/lib/db/repo";
import { sendSms } from "@/lib/notify/sms";
import { getSettings } from "@/lib/settings";
import { viewerQuoUserId } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

function whenLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: getSettings().timezone || "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.SMS_SEND_ENABLED !== "true") {
    return NextResponse.json({ ok: false, disabled: true, error: "Texting is off — set SMS_SEND_ENABLED=true to enable." });
  }

  let body: { id?: string; phone?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });

  const pass = getShiftPass(id);
  if (!pass) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const phone = (body.phone ?? "").trim() || (pass.phone ?? "").trim();
  if (!phone) return NextResponse.json({ ok: false, error: "No phone number for this pass — add one first." });

  const url = `${new URL(req.url).origin}/pass/${pass.id}`;
  const first = (pass.name || "there").split(/\s+/)[0];
  const text =
    `Hi ${first}, here is your Zoe Events shift access. Open this link on your phone or tablet to see today's dispatch: ${url} ` +
    `Access ends ${whenLabel(pass.expiresAt)}. Keep the link private.`;

  const userId = (await viewerQuoUserId()) || undefined;
  const res = await sendSms(phone, text, { userId });
  if (res.ok) return NextResponse.json({ ok: true, to: phone });
  return NextResponse.json({ ok: false, error: res.error ?? "send failed", skipped: res.skipped });
}
