// One call's full detail (side-panel): the enriched row, parsed transcript with speaker labels, the AI
// summary, the actions we actually recorded, the assembled Context Pack, and a handoff brief if it was
// escalated. PATCH sets or clears the HUMAN reason override (reversible; the calculated reason returns
// when cleared). Nothing here is fabricated — absent facts render as Unavailable.

import { NextResponse } from "next/server";
import { buildCallCard } from "@/lib/comms/queue";
import { setReasonOverride, clearReasonOverride } from "@/lib/comms/store";
import { CALL_REASONS, type CallReason } from "@/lib/comms/reasons";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const card = await buildCallCard(id);
  if (!card) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(card);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  let body: { reason?: CallReason | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.reason === null) {
    clearReasonOverride(id);
  } else if (body.reason !== undefined) {
    if (!(CALL_REASONS as string[]).includes(body.reason)) return NextResponse.json({ error: "bad_reason" }, { status: 400 });
    const actor = await currentActor();
    setReasonOverride(id, body.reason, actor.label);
  }
  const card = await buildCallCard(id);
  if (!card) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, card });
}
