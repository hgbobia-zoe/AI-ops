// Coach brief endpoint (Phase 10) — Custodian pulls a lead's live-coaching brief (state + next-best-
// action + call brief + real prior contact) so its on-screen coaching is grounded in Zoe's own data.
// Bearer auth via COACH_API_TOKEN (fail-closed — off until the token is set). Read-only.
//
//   GET /api/coach/brief?leadId=<id>      or   ?phone=<customer number>

import { NextResponse } from "next/server";
import { coachAuthOk, coachBrief, coachResolveLead } from "@/lib/salesos/coach";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  if (!coachAuthOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const leadId = url.searchParams.get("leadId");
  const phone = url.searchParams.get("phone");
  if (!leadId && !phone) return NextResponse.json({ error: "leadId or phone required" }, { status: 400 });

  // Resolve by phone first (Custodian may only know the number), then load the brief by lead id.
  const booking = coachResolveLead(leadId, phone);
  if (!booking) return NextResponse.json({ found: false }, { status: 404 });

  const brief = coachBrief(booking.bookingId);
  if (!brief) return NextResponse.json({ found: false }, { status: 404 });
  return NextResponse.json({ found: true, brief });
}
