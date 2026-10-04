// AI Org v2 — a human decision on an approval request. Owner/admin only. APPROVE routes to the EXISTING
// execution path (a gs_outbox op), respecting the send gates; REJECT / EDIT / REQUEST MORE INFO just
// record. Idempotent: deciding an already-decided request never double-executes. Every decision is
// audited inside decideApproval.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { decideApproval, type ApprovalDecision } from "@/lib/aiorg/approvals";

export const dynamic = "force-dynamic";

const DECISIONS: ApprovalDecision[] = ["approve", "reject", "edit", "request_info"];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageSettings(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  let body: { decision?: string; note?: string; payload?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const decision = (body.decision ?? "").trim() as ApprovalDecision;
  if (!DECISIONS.includes(decision)) return NextResponse.json({ error: "bad_decision", detail: `Expected one of ${DECISIONS.join(", ")}.` }, { status: 400 });

  const actor = (await currentActor()).label;
  try {
    const result = decideApproval(id, decision, actor, { note: body.note, editedPayload: body.payload });
    return NextResponse.json({ ok: true, outcome: result.outcome, message: result.message, status: result.approval.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "decision_failed";
    return NextResponse.json({ ok: false, error: msg }, { status: msg === "approval not found" ? 404 : 500 });
  }
}
