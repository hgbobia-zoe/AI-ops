// Human review actions for a job: approve a generation, reject, request revision, or save (publish) the
// approved asset. Every action is attributed to currentActor and audited by the service layer.

import { NextResponse } from "next/server";
import { getJob, listGenerations, listEvents } from "@/lib/creative/store";
import { approveGeneration, rejectJob, requestRevision, publishAsset } from "@/lib/creative/service";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

interface Body {
  action: "approve" | "reject" | "revision" | "publish";
  generationId?: string;
  note?: string;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  if (!getJob(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const actor = (await currentActor()).label;

  let job = null;
  switch (body.action) {
    case "approve":
      if (!body.generationId) return NextResponse.json({ error: "generationId_required" }, { status: 400 });
      job = approveGeneration(id, body.generationId, actor);
      break;
    case "reject":
      job = rejectJob(id, actor, body.note);
      break;
    case "revision":
      job = requestRevision(id, actor, body.note);
      break;
    case "publish":
      job = publishAsset(id, actor);
      if (!job) return NextResponse.json({ error: "not_approved" }, { status: 409 });
      break;
    default:
      return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  }
  return NextResponse.json({ ok: !!job, job: job ?? getJob(id), generations: listGenerations(id), events: listEvents(id) });
}
