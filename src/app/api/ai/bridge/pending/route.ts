// AI Control Plane — the Session Bridge DRAIN QUEUE. A connected responder (an Agent-SDK worker or a Claude
// Code session) polls this to find sessions holding an unanswered human instruction, works each one, then
// claims + posts the result back via POST /api/ai/bridge. This endpoint is read-only: it NEVER mutates a
// session or executes anything. Auth is the same two-path gate as the bridge endpoint — an owner/admin
// browser cookie OR the shared x-bridge-token (only valid when AI_BRIDGE_TOKEN is configured).

import { NextResponse } from "next/server";
import { listPendingInstructions, countPendingInstructions } from "@/lib/ai/sessions";
import { bridgeTokenValid, activeAiProviderId, bridgeConnected } from "@/lib/ai/provider";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/** Owner/admin cookie OR a valid responder token. */
async function authorized(req: Request): Promise<boolean> {
  if (bridgeTokenValid(req.headers.get("x-bridge-token"))) return true;
  return canManageAi(await viewerRole());
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await authorized(req))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const n = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 20;
  return NextResponse.json({
    ok: true,
    pending: listPendingInstructions(limit),
    total: countPendingInstructions(),
    activeProvider: activeAiProviderId(),
    bridgeConnected: bridgeConnected(),
  });
}
