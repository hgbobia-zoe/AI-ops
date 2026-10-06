// AI Control Plane — append one timeline event to a session, or end it (operate level). A session records
// what it did here; it never executes a side effect through this route.

import { NextResponse } from "next/server";
import { appendEvent, endSession, recordToolRun, type SessionEventKind, type ToolRunStatus } from "@/lib/ai/sessions";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canOperateAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const EVENT_KINDS: SessionEventKind[] = ["started", "step", "tool_call", "message", "state_change", "approval_raised", "finished", "error"];

export async function POST(req: Request): Promise<NextResponse> {
  if (!canOperateAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: {
    sessionId?: string;
    kind?: string;
    label?: string;
    payload?: Record<string, unknown>;
    changeKey?: string;
    // tool-run shorthand
    tool?: { toolId?: string; category?: string; perm?: string; args?: Record<string, unknown>; result?: Record<string, unknown>; status?: string; error?: string };
    // end shorthand
    end?: { outcome?: string; result?: Record<string, unknown>; error?: string };
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const sessionId = (body.sessionId ?? "").trim();
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  const actor = (await currentActor()).label;

  if (body.end) {
    const outcome = body.end.outcome;
    if (outcome !== "done" && outcome !== "failed" && outcome !== "cancelled") {
      return NextResponse.json({ error: "bad_outcome" }, { status: 400 });
    }
    const s = endSession(sessionId, outcome, { result: body.end.result, error: body.end.error, actor });
    if (!s) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, session: s });
  }

  if (body.tool) {
    const toolId = (body.tool.toolId ?? "").trim();
    if (!toolId) return NextResponse.json({ error: "toolId required" }, { status: 400 });
    const status: ToolRunStatus = body.tool.status === "error" ? "error" : "ok";
    const run = recordToolRun(sessionId, {
      toolId,
      category: body.tool.category,
      perm: body.tool.perm,
      args: body.tool.args,
      result: body.tool.result,
      status,
      error: body.tool.error,
    });
    return NextResponse.json({ ok: true, tool: run });
  }

  const kind = body.kind as SessionEventKind | undefined;
  if (!kind || !EVENT_KINDS.includes(kind)) return NextResponse.json({ error: "bad_kind" }, { status: 400 });
  const ev = appendEvent(sessionId, { kind, actor, label: body.label, payload: body.payload, changeKey: body.changeKey });
  return NextResponse.json({ ok: true, event: ev });
}
