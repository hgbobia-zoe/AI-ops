// AI Control Plane — the Claude Session Bridge registration endpoint (manage level; proxy-gated to owner/
// admin). A connected Claude / Claude Code session heartbeats here to mark the bridge live, and posts an
// interpretation result back into a session. This is the "connect an existing session rather than pay per
// call" path. It NEVER returns provider credentials or secrets to the browser — only status.

import { NextResponse } from "next/server";
import { setBridgeConnected, bridgeConnected, activeAiProviderId } from "@/lib/ai/provider";
import { setSessionResult, appendEvent, endSession, getSession } from "@/lib/ai/sessions";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ connected: bridgeConnected(), activeProvider: activeAiProviderId() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { connected?: boolean; sessionId?: string; result?: Record<string, unknown>; end?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Heartbeat / connect-disconnect toggle.
  if (typeof body.connected === "boolean") setBridgeConnected(body.connected);

  // Optional: a connected session posts its interpreted result back into an AI session.
  if (body.sessionId && body.result) {
    const sid = body.sessionId.trim();
    if (!getSession(sid)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const actor = (await currentActor()).label;
    setSessionResult(sid, body.result);
    appendEvent(sid, { kind: "message", actor, label: "Result posted by the connected session" });
    if (body.end) endSession(sid, "done", { result: body.result, actor });
  }

  return NextResponse.json({ ok: true, connected: bridgeConnected() });
}
