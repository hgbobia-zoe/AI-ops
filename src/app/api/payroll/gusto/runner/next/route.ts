// Gusto remote-browser push — the office runner (tools/gusto-runner) claims the next queued push job here.
// Token-gated (GUSTO_RUNNER_TOKEN via x-gusto-runner-token), fail-CLOSED: 503 until the token is configured,
// so nothing is ever claimed on an unconfigured deployment. NOT role-gated (no human session). Single-
// assignment is enforced in the store (claimNextQueued's guarded UPDATE), so two runners can't grab the same
// job. The returned job carries the approved per-worker entries the runner replays.

import { NextResponse } from "next/server";
import { claimNextQueued } from "@/lib/payroll/gustoRunnerJobs";
import { checkGustoRunnerToken } from "@/lib/payroll/gustoRunnerAuth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const auth = checkGustoRunnerToken(req.headers.get("x-gusto-runner-token"));
  if (auth === "unconfigured") return NextResponse.json({ error: "runner_disabled" }, { status: 503 });
  if (auth === "forbidden") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // job === null simply means the queue is empty — a normal, successful poll.
  const job = claimNextQueued();
  return NextResponse.json({ ok: true, job });
}
