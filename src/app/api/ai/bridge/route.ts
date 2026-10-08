// AI Control Plane — the Claude Session Bridge endpoint. A connected responder (a Claude / Claude Code
// session, or an Agent-SDK worker) heartbeats here to mark the bridge live, CLAIMS a pending instruction
// before working it, and posts its interpreted result back into a session. This is the "connect an existing
// session rather than pay per call" path. It NEVER returns provider credentials or secrets to the browser —
// only status. Governing law holds: a posted result is interpretation text on the timeline; any operational
// write still goes through an approval, never from here.
//
// Auth: an owner/admin browser cookie OR the shared x-bridge-token (valid only when AI_BRIDGE_TOKEN is set).
// A headless responder uses the token; a human operator in the app uses their cookie.

import { NextResponse } from "next/server";
import { setBridgeConnected, bridgeConnected, activeAiProviderId, bridgeTokenValid } from "@/lib/ai/provider";
import { setSessionResult, appendEvent, endSession, getSession, claimInstruction } from "@/lib/ai/sessions";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const tokenAuthed = bridgeTokenValid(req.headers.get("x-bridge-token"));
  if (!tokenAuthed && !canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ connected: bridgeConnected(), activeProvider: activeAiProviderId() });
}

export async function POST(req: Request): Promise<NextResponse> {
  const tokenAuthed = bridgeTokenValid(req.headers.get("x-bridge-token"));
  if (!tokenAuthed && !canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { connected?: boolean; sessionId?: string; result?: Record<string, unknown>; end?: boolean; claim?: boolean; instructionTs?: string; note?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // A token-authed headless responder has no cookie identity; attribute its writes to "AI responder".
  const actor = tokenAuthed ? "AI responder" : (await currentActor()).label;

  // Heartbeat / connect-disconnect toggle.
  if (typeof body.connected === "boolean") setBridgeConnected(body.connected);

  // Claim: the responder marks a pending instruction as being worked on (shows progress to the human and
  // drops it from the drain queue so a second responder can't double-handle it). Idempotent per instruction.
  if (body.claim && body.sessionId) {
    const sid = body.sessionId.trim();
    if (!getSession(sid)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!body.instructionTs) return NextResponse.json({ error: "instructionTs required to claim" }, { status: 400 });
    const ev = claimInstruction(sid, body.instructionTs, body.note, actor);
    return NextResponse.json({ ok: true, claimed: ev !== null, connected: bridgeConnected() });
  }

  // A connected session posts its interpreted result back into a session.
  if (body.sessionId && body.result) {
    const sid = body.sessionId.trim();
    if (!getSession(sid)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    setSessionResult(sid, body.result);
    appendEvent(sid, { kind: "message", actor, label: "Result posted by the connected session" });
    if (body.end) endSession(sid, "done", { result: body.result, actor });
  }

  return NextResponse.json({ ok: true, connected: bridgeConnected() });
}
