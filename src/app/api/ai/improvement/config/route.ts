// Self-Improvement Controller — governance config. The change budget (gate 4) and the autonomy switches
// (gate 7: autoMerge/autoDeploy/autoRollback) are set HERE, by a human (owner/admin only). The controller
// reads these; it never writes them. A headless responder token is NOT accepted — the agent cannot widen
// its own budget or enable its own autonomy (audit gate 12).

import { NextResponse } from "next/server";
import { improvementBudget, setImprovementBudget, autonomyConfig, setAutonomyConfig, DEFAULT_IMPROVEMENT_BUDGET } from "@/lib/ai/improvement/config";
import type { ChangeBudget } from "@/lib/ai/improvement/types";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, budget: improvementBudget(), defaults: DEFAULT_IMPROVEMENT_BUDGET, autonomy: autonomyConfig() });
}

export async function POST(req: Request): Promise<NextResponse> {
  // Human-only (owner/admin). NO token path: enabling autonomy or widening the budget is a safety control.
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { budget?: Partial<ChangeBudget>; autonomy?: { autoMerge?: boolean; autoDeploy?: boolean; autoRollback?: boolean } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.budget) setImprovementBudget(body.budget);
  if (body.autonomy) setAutonomyConfig(body.autonomy);
  return NextResponse.json({ ok: true, budget: improvementBudget(), autonomy: autonomyConfig() });
}
