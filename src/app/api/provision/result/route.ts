// Where the Auto-Pull extension reports a Chrome-run account setup step (people/chromeJobs.ts). PUBLIC in
// proxy.ts: the extension's service worker has no Zoe session. The gate is the one-time key handed out with
// the job (stored hashed, expires in 2 hours, single use), so a report can only land on the step it was for.

import { NextResponse } from "next/server";
import { applyChromeResult, type ChromeOutcome } from "@/lib/people/chromeJobs";

export const dynamic = "force-dynamic";

const OUTCOMES: ChromeOutcome[] = ["done", "invited", "already", "failed", "declined", "by_hand"];

export async function POST(req: Request): Promise<NextResponse> {
  let body: { taskId?: unknown; token?: unknown; outcome?: unknown; detail?: unknown; createdEmail?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const token = typeof body.token === "string" ? body.token : "";
  const outcome = OUTCOMES.find((o) => o === body.outcome);
  if (!taskId || !token || !outcome) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const r = applyChromeResult({
    taskId,
    token,
    outcome,
    detail: typeof body.detail === "string" ? body.detail : undefined,
    createdEmail: typeof body.createdEmail === "string" ? body.createdEmail : undefined,
  });
  return NextResponse.json(r, { status: r.ok ? 200 : 403 });
}
