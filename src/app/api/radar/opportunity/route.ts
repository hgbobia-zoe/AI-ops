// Event Radar → Sales OS handoff. Creating an opportunity does NOT duplicate the event: the
// radar_event stays the source record and this writes the bridge (radar_opportunities), advancing the
// event to HANDED_OFF. Idempotent per event. Proxy-gated to signed-in console users; attributes the act.

import { NextResponse } from "next/server";
import { getEvent, createOpportunity } from "@/lib/radar/store";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { eventId?: string; note?: string; nextAction?: string; bookingId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const eventId = (body.eventId ?? "").trim();
  if (!eventId) return NextResponse.json({ error: "eventId required" }, { status: 400 });

  const event = getEvent(eventId);
  if (!event) return NextResponse.json({ error: "event not found" }, { status: 404 });

  const actor = (await currentActor()).label;
  const opp = createOpportunity(eventId, {
    note: body.note?.trim() || undefined,
    nextAction: body.nextAction?.trim() || undefined,
    bookingId: body.bookingId?.trim() || undefined,
    createdBy: actor,
  });
  return NextResponse.json({ ok: true, opportunity: opp });
}
