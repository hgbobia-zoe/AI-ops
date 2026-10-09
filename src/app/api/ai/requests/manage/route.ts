// AI Control Plane — Requests backlog management. `status` (triage / decline / mark done) is a product-
// owner decision → manage level (owner/admin). `attach_pr` records the implementation PR a responder opened
// and moves the request to in_review → the responder (x-bridge-token) OR owner/admin. Neither merges nor
// deploys anything: the human MERGE of the PR is the approval.

import { NextResponse } from "next/server";
import { setRequestStatus, attachRequestPr, REQUEST_STATUSES, type AiRequestStatus } from "@/lib/ai/requests";
import { bridgeTokenValid } from "@/lib/ai/provider";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const tokenAuthed = bridgeTokenValid(req.headers.get("x-bridge-token"));
  const manager = canManageAi(await viewerRole());
  let body: { requestId?: string; op?: string; status?: string; notes?: string; prUrl?: string; prNumber?: number; branch?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const requestId = (body.requestId ?? "").trim();
  if (!requestId) return NextResponse.json({ error: "requestId required" }, { status: 400 });
  const actor = tokenAuthed ? "AI responder" : (await currentActor()).label;

  if (body.op === "attach_pr") {
    // The responder (or a manager) records the implementation PR.
    if (!tokenAuthed && !manager) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const url = (body.prUrl ?? "").trim();
    if (!url) return NextResponse.json({ error: "prUrl required" }, { status: 400 });
    const r = attachRequestPr(requestId, { url, number: body.prNumber, branch: body.branch }, actor);
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, request: r });
  }

  // Status change is a product-owner decision — manage level only (never the headless responder).
  if (body.op === "status") {
    if (!manager) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const status = body.status as AiRequestStatus | undefined;
    if (!status || !REQUEST_STATUSES.includes(status)) return NextResponse.json({ error: "bad_status" }, { status: 400 });
    const r = setRequestStatus(requestId, status, { notes: body.notes, actor });
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, request: r });
  }

  return NextResponse.json({ error: "bad_op" }, { status: 400 });
}
