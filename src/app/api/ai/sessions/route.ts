// AI Control Plane — session lifecycle (operate level: any signed staff; the proxy gates /api/ai but this
// is NOT under a manage-only prefix). GET lists recent sessions, or one session with its timeline + tools
// + raised approvals when ?id= is given. POST opens a new session. Deciding actions, connecting the bridge
// and config live under the manage-gated /api/ai/* prefixes instead.

import { NextResponse } from "next/server";
import {
  createSession,
  getSession as getAiSession,
  listRecentSessions,
  listSessionEvents,
  listSessionTools,
  listSessionApprovalIds,
} from "@/lib/ai/sessions";
import { getEmployee } from "@/lib/aiorg/registry";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canViewAi, canOperateAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  if (!canViewAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id")?.trim();
  if (id) {
    const session = getAiSession(id);
    if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({
      session,
      events: listSessionEvents(id),
      tools: listSessionTools(id),
      approvalIds: listSessionApprovalIds(id),
    });
  }
  return NextResponse.json({ sessions: listRecentSessions(100) });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canOperateAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { agentId?: string; blade?: string; title?: string; input?: Record<string, unknown>; idempotencyKey?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const agentId = (body.agentId ?? "").trim();
  if (!agentId) return NextResponse.json({ error: "agentId required" }, { status: 400 });
  const emp = getEmployee(agentId);
  if (!emp) return NextResponse.json({ error: "unknown_agent" }, { status: 400 });
  const title = (body.title ?? "").trim() || `${emp.name} session`;

  const actor = (await currentActor()).label;
  const session = createSession({
    agentId,
    blade: body.blade?.trim() || emp.blade,
    owner: emp.owner,
    startedBy: actor,
    title,
    input: body.input,
    idempotencyKey: body.idempotencyKey?.trim() || undefined,
  });
  return NextResponse.json({ ok: true, session });
}
