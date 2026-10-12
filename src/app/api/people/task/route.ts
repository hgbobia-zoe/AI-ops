// People Lifecycle — act on a provisioning task. Owner/admin only (canManageUsers; proxy also gates
// /api/people). approve_execute runs the automated adapter behind the approval gate (Zoe platform only);
// mark_complete records a verified human completion of a manual/future task; retry/skip manage state.

import { NextResponse } from "next/server";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageUsers } from "@/lib/auth/roles";
import { executeAutomatedTask, markTaskComplete, retryTask, skipTask } from "@/lib/people/lifecycle";

export const dynamic = "force-dynamic";

type Action = "approve_execute" | "mark_complete" | "retry" | "skip";
const ACTIONS: Action[] = ["approve_execute", "mark_complete", "retry", "skip"];

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { taskId?: string; action?: string; note?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const taskId = (body.taskId ?? "").trim();
  if (!taskId) return NextResponse.json({ error: "taskId required" }, { status: 400 });
  const action = body.action as Action | undefined;
  if (!action || !ACTIONS.includes(action)) return NextResponse.json({ error: "bad_action" }, { status: 400 });

  const actor = (await currentActor()).label;
  const result =
    action === "approve_execute" ? await executeAutomatedTask(taskId, actor)
    : action === "mark_complete" ? markTaskComplete(taskId, actor, body.note)
    : action === "retry" ? retryTask(taskId, actor)
    : skipTask(taskId, actor);

  return NextResponse.json(
    { ok: result.ok, message: result.message, status: result.task?.status ?? null, externalRef: result.task?.externalRef ?? null },
    { status: result.ok ? 200 : 409 },
  );
}
