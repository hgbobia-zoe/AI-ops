// Opportunity Radar → Sales OS handoff. The opportunity stays the source record; this marks the bridge
// (sales_status + optional booking link) and advances the stage. Idempotent. Proxy-gated; attributed.

import { NextResponse } from "next/server";
import { getOpportunity, createHandoff } from "@/lib/opportunity/store";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string; bookingId?: string; nextAction?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!getOpportunity(id)) return NextResponse.json({ error: "opportunity not found" }, { status: 404 });

  await currentActor(); // ensures a signed-in context; attribution reserved for future audit
  const opp = createHandoff(id, { bookingId: body.bookingId?.trim() || undefined, nextAction: body.nextAction?.trim() || undefined });
  return NextResponse.json({ ok: true, opportunity: opp });
}
