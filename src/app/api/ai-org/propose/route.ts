// AI Org v2 — human-triggered, bounded proposal generation. An owner/admin clicks "Draft & propose"
// on the Approvals page; this runs the named employee's proposer, which CREATES approval requests from
// that employee's REAL drafts/signals (capped, idempotent). It never sends or executes anything.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { proposeOutreachApprovals, proposeLostQuoteApprovals } from "@/lib/aiorg/proposers";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageSettings(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { agent?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const agent = (body.agent ?? "").trim();

  try {
    if (agent === "outreach") return NextResponse.json({ ok: true, result: await proposeOutreachApprovals() });
    if (agent === "lost-quote") return NextResponse.json({ ok: true, result: await proposeLostQuoteApprovals() });
    return NextResponse.json({ error: "unknown_agent", detail: "Expected 'outreach' or 'lost-quote'." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "propose_failed" }, { status: 500 });
  }
}
