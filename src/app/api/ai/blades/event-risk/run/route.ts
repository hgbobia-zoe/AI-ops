// AI Control Plane: Event Risk playbook runner (operate level: any signed staff). Runs "Event Risk Review"
// as a real AI session over the live risk queue and returns the session so the UI can open it. Read-only.

import { NextResponse } from "next/server";
import { runEventRiskReview } from "@/lib/ai/blades/eventRisk";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canOperateAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canOperateAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { horizonDays?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const horizonDays = typeof body.horizonDays === "number" && body.horizonDays > 0 ? Math.min(60, Math.round(body.horizonDays)) : undefined;
  const session = runEventRiskReview({ actor: (await currentActor()).label, horizonDays });
  return NextResponse.json({ ok: true, session });
}
