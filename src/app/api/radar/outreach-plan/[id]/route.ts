// Guided Outreach Plan API — the coached playbook + running state for one opportunity. Any staff member
// (the whole point is to help people who aren't natural salespeople). GET returns the plan + saved
// progress; POST op "save" persists progress/notes/status; op "refine" AI-polishes the scripts (no save).

import { NextResponse } from "next/server";
import { buildOutreachPlan, refinePlanScripts } from "@/lib/opportunity/outreachPlan";
import { getPlanState, savePlanState, type PlanSaveInput } from "@/lib/opportunity/outreachPlanState";
import { viewerFirstName } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const rep = (await viewerFirstName()) ?? "[your name]";
  const plan = buildOutreachPlan(id, rep);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ plan, state: getPlanState(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  let body: { op?: string; state?: PlanSaveInput };
  try {
    body = (await req.json()) as { op?: string; state?: PlanSaveInput };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.op === "refine") {
    const rep = (await viewerFirstName()) ?? "[your name]";
    const plan = buildOutreachPlan(id, rep);
    if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ refined: await refinePlanScripts(plan) });
  }

  if (body.op === "save") {
    return NextResponse.json({ ok: true, state: savePlanState(id, body.state ?? {}) });
  }

  return NextResponse.json({ error: "unknown_op" }, { status: 400 });
}
