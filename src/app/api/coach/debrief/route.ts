// Coach debrief endpoint (Phase 10 + 11) — Custodian posts a call's post-call recap; it flows through
// the same debrief path a Quo call takes: onto the lead's timeline, into the state machine, and (queued)
// to Goodshuffle notes. Closes the loop for calls Custodian coached, including non-Quo calls (cell on
// speaker). Bearer auth via COACH_API_TOKEN. Never sends anything to the customer.
//
//   POST /api/coach/debrief
//   { leadId?, phone?, sessionId?, transcript?, summary?, durationSec?, agentInitials?, agentName? }

import { NextResponse } from "next/server";
import { coachAuthOk, applyCoachDebrief, type CoachDebriefInput } from "@/lib/salesos/coach";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!coachAuthOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: CoachDebriefInput;
  try {
    body = (await req.json()) as CoachDebriefInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.leadId && !body.phone) return NextResponse.json({ error: "leadId or phone required" }, { status: 400 });
  if (!body.transcript && !body.summary) return NextResponse.json({ error: "transcript or summary required" }, { status: 400 });

  const result = await applyCoachDebrief(body);
  return NextResponse.json(result);
}
