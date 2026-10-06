// AI Control Plane — decide an AI-proposed action (manage level; proxy-gated owner/admin). This is a thin
// wrapper over the EXISTING decideApproval state machine: approve routes to the proven gs_outbox path
// (respecting EMAIL_SEND_ENABLED; money/pricing/schedule/hiring/instawork stay FORBIDDEN to execute), and
// reject/edit/request_info just record. The approval row is the single source of truth — a session only
// linked to it. Nothing new executes here.

import { NextResponse } from "next/server";
import { decideApproval, getApproval, type ApprovalDecision } from "@/lib/aiorg/approvals";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canApproveAi, canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const DECISIONS: ApprovalDecision[] = ["approve", "reject", "edit", "request_info"];

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canApproveAi(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { id?: string; decision?: string; note?: string; editedPayload?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const decision = body.decision as ApprovalDecision | undefined;
  if (!decision || !DECISIONS.includes(decision)) return NextResponse.json({ error: "bad_decision" }, { status: 400 });

  const existing = getApproval(id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // A financial card requires financial-viewing permission to decide (canApproveAi is owner/admin, which
  // already implies canSeeFinancials — this is an explicit belt-and-braces check, never AI as authority).
  if (existing.financial && !canSeeFinancials(role)) return NextResponse.json({ error: "forbidden_financial" }, { status: 403 });

  const actor = (await currentActor()).label;
  const result = decideApproval(id, decision, actor, { note: body.note, editedPayload: body.editedPayload });
  return NextResponse.json({ ok: true, outcome: result.outcome, message: result.message, approval: result.approval });
}
