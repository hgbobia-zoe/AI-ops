// Log a prospecting task outcome or skip it. A "replied"/"meeting" outcome pauses the sequence and
// moves the opportunity to ENGAGED (a human then converts it in Goodshuffle). Proxy-gated + attributed.

import { NextResponse } from "next/server";
import { logOutcome, skipTask } from "@/lib/prospecting/service";
import { currentActor } from "@/lib/auth/getSession";
import { OUTCOME_LABEL, type TaskOutcome } from "@/lib/prospecting/types";

export const dynamic = "force-dynamic";

const VALID = new Set(Object.keys(OUTCOME_LABEL));

export async function POST(req: Request): Promise<NextResponse> {
  let body: { action?: string; taskId?: string; outcome?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const taskId = (body.taskId ?? "").trim();
  if (!taskId) return NextResponse.json({ error: "taskId required" }, { status: 400 });

  if (body.action === "skip") {
    const t = skipTask(taskId);
    return t ? NextResponse.json({ ok: true, task: t }) : NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const outcome = body.outcome as TaskOutcome | undefined;
  if (outcome && !VALID.has(outcome)) return NextResponse.json({ error: "invalid outcome" }, { status: 400 });
  const actor = (await currentActor()).label;
  const t = logOutcome(taskId, outcome ?? null, actor);
  return t ? NextResponse.json({ ok: true, task: t }) : NextResponse.json({ error: "not found" }, { status: 404 });
}
