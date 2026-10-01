// One SEO opportunity's detail (side panel) + its Kanban transitions. Owner/admin only (proxy-gated with the
// rest of /api/seo). Attributes every move to the current actor.
//
//   GET  → { opportunity, history, nextStages }
//   POST → body { op: "stage", stage } | { op: "decision", decision: "approve"|"defer"|"reject", note? }
//          applies a GUARDED stage transition (invalid moves are rejected 400, nothing written) and returns
//          the refreshed detail.

import { NextResponse } from "next/server";
import { getOpportunity, decisionHistory, setOpportunityStage } from "@/lib/seo/store";
import { nextStages, isStage } from "@/lib/seo/stages";
import { currentActor } from "@/lib/auth/getSession";
import type { SeoStage } from "@/lib/seo/types";

export const dynamic = "force-dynamic";

function detail(id: string): NextResponse {
  const opportunity = getOpportunity(id);
  if (!opportunity) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ opportunity, history: decisionHistory(id), nextStages: nextStages(opportunity.stage) });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  return detail(id);
}

const DECISION_STAGE: Record<string, SeoStage> = { approve: "APPROVED", defer: "DEFERRED", reject: "REJECTED" };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  let body: { op?: string; stage?: string; decision?: string; note?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  let to: SeoStage | null = null;
  let note = body.note ?? null;
  if (body.op === "decision") {
    const stage = DECISION_STAGE[(body.decision ?? "").toLowerCase()];
    if (!stage) return NextResponse.json({ error: "bad_decision" }, { status: 400 });
    to = stage;
    note = note ?? `decision: ${body.decision}`;
  } else if (body.op === "stage") {
    if (!isStage(body.stage)) return NextResponse.json({ error: "bad_stage" }, { status: 400 });
    to = body.stage;
  } else {
    return NextResponse.json({ error: "bad_op" }, { status: 400 });
  }

  const actor = (await currentActor()).label;
  const res = setOpportunityStage(id, to, actor, note);
  if (!res.ok) {
    const code = res.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: res.error ?? "transition_failed", from: res.from, to: res.to }, { status: code });
  }
  return detail(id);
}
