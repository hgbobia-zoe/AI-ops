// Re-analyze ONE lead's customer state from its full context — the Goodshuffle activity log (dated
// notes of calls/texts/emails), client note, and recent messages — not just contact recency. Fixes a
// false "Dormant" when the team actually reached the customer (it's in the notes). On-demand, from the
// lead panel's "Re-analyze" button. Proxy-gated to signed-in console users. INFERENCE, never auto-send.

import { NextResponse } from "next/server";
import { reanalyzeLead } from "@/lib/salesos/stateService";
import { STATE_LABEL } from "@/lib/salesos/state";
import { logSalesEvent } from "@/lib/salesos/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const resolved = await reanalyzeLead(id);
  if (!resolved) return NextResponse.json({ error: "lead not found" }, { status: 404 });

  await logSalesEvent("STATE_REANALYZED", id, { state: resolved.state, source: resolved.source });
  return NextResponse.json({
    ok: true,
    state: {
      label: STATE_LABEL[resolved.state],
      reason: resolved.reason,
      evidence: resolved.source === "inbound_reply" || resolved.source === "notes" ? resolved.evidence : null,
      confidence: Math.round(resolved.confidence * 100),
    },
  });
}
