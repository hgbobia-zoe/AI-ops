// Opportunity Radar outreach API (§10). DETECT → DRAFT → APPROVE → SEND → TRACK, human-in-the-loop.
// Actions: draft (generate + save a draft), edit, status (approve/sent/skip). "sent" is a RECORDED
// action (no automated blast) and advances the opportunity to CONTACTED. Proxy-gated + attributed.

import { NextResponse } from "next/server";
import { draftOpportunityOutreach } from "@/lib/opportunity/outreach";
import { saveDraft, setOutreachStatus, editOutreach } from "@/lib/opportunity/outreachStore";
import { singleView } from "@/lib/opportunity/service";
import { currentActor, viewerFirstName } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { action?: string; id?: string; outreachId?: string; status?: string; entityId?: string; subject?: string; body?: string; callScript?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const action = body.action;

  if (action === "draft") {
    const id = (body.id ?? "").trim();
    const view = singleView(id);
    if (!view) return NextResponse.json({ error: "opportunity not found" }, { status: 404 });
    const repName = (await viewerFirstName()) ?? undefined;
    const actor = (await currentActor()).label;
    const draft = await draftOpportunityOutreach(id, { repName });
    if (!draft) return NextResponse.json({ error: "could not draft" }, { status: 500 });
    const entityId = body.entityId?.trim() || view.primaryTarget?.edge.entity.id || null;
    const saved = saveDraft(id, entityId, draft, actor);
    return NextResponse.json({ ok: true, outreach: saved });
  }

  if (action === "edit") {
    const oid = (body.outreachId ?? "").trim();
    const updated = editOutreach(oid, { subject: body.subject, body: body.body, callScript: body.callScript });
    return updated ? NextResponse.json({ ok: true, outreach: updated }) : NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (action === "status") {
    const oid = (body.outreachId ?? "").trim();
    const status = body.status as "draft" | "approved" | "sent" | "skipped";
    if (!["draft", "approved", "sent", "skipped"].includes(status)) return NextResponse.json({ error: "invalid status" }, { status: 400 });
    const updated = setOutreachStatus(oid, status);
    return updated ? NextResponse.json({ ok: true, outreach: updated }) : NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
