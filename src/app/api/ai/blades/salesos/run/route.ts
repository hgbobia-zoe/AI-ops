// AI Control Plane — Sales OS playbook runner (operate level: any signed staff). Runs the "Lost Quote
// Recovery" playbook as a real AI session over live data and returns the session so the UI can open it.
// This is the first real blade wired to the operating layer. It records analysis and surfaces a
// recommendation; any action it proposes still goes through the approval queue.

import { NextResponse } from "next/server";
import { runLostQuoteRecovery } from "@/lib/ai/blades/salesos";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canOperateAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canOperateAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { windowDays?: number; topN?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const actor = (await currentActor()).label;
  const windowDays = typeof body.windowDays === "number" && body.windowDays > 0 ? Math.min(365, Math.round(body.windowDays)) : undefined;
  const topN = typeof body.topN === "number" && body.topN > 0 ? Math.min(25, Math.round(body.topN)) : undefined;
  const session = runLostQuoteRecovery({ actor, windowDays, topN });
  return NextResponse.json({ ok: true, session });
}
