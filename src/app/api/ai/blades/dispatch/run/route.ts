// AI Control Plane: Dispatch playbook runner (operate level: any signed staff). Runs "Route Health Check"
// as a real AI session over today's routes, overdue routes and open exceptions. Read-only.

import { NextResponse } from "next/server";
import { runRouteHealthPlaybook } from "@/lib/ai/blades/dispatch";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canOperateAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  if (!canOperateAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const session = runRouteHealthPlaybook({ actor: (await currentActor()).label });
  return NextResponse.json({ ok: true, session });
}
