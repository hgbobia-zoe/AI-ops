// AI Control Plane — session persistence actions (operate level: any signed staff). Pause / resume /
// rename / set-objective / archive / send a new instruction. None of these execute an operational side
// effect; they only change the session's own record. Mutations an AI proposes still go through approvals.

import { NextResponse } from "next/server";
import {
  pauseSession,
  resumeSession,
  renameSession,
  setObjective,
  archiveSession,
  addInstruction,
  type AiSession,
} from "@/lib/ai/sessions";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canOperateAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

type Op = "pause" | "resume" | "rename" | "objective" | "archive" | "instruct";
const OPS: Op[] = ["pause", "resume", "rename", "objective", "archive", "instruct"];

export async function POST(req: Request): Promise<NextResponse> {
  if (!canOperateAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { sessionId?: string; op?: string; title?: string; objective?: string; archived?: boolean; text?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const sessionId = (body.sessionId ?? "").trim();
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  const op = body.op as Op | undefined;
  if (!op || !OPS.includes(op)) return NextResponse.json({ error: "bad_op" }, { status: 400 });

  const actor = (await currentActor()).label;
  let result: AiSession | null = null;
  switch (op) {
    case "pause":
      result = pauseSession(sessionId, actor);
      break;
    case "resume":
      result = resumeSession(sessionId, actor);
      break;
    case "rename":
      if (!(body.title ?? "").trim()) return NextResponse.json({ error: "title required" }, { status: 400 });
      result = renameSession(sessionId, body.title!, actor);
      break;
    case "objective":
      result = setObjective(sessionId, body.objective ?? "", actor);
      break;
    case "archive":
      result = archiveSession(sessionId, body.archived !== false, actor);
      break;
    case "instruct":
      if (!(body.text ?? "").trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
      result = addInstruction(sessionId, body.text!, actor);
      break;
  }
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, session: result });
}
