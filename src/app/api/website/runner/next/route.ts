// Website Studio — the office runner claims the next pending job here. Token-gated (WEBSITE_RUNNER_TOKEN via
// the x-website-runner-token header), fail-CLOSED: 503 until the token is configured, so nothing is ever
// claimed on an unconfigured deployment. NOT role-gated (no human session). Single-assignment is enforced in
// the store (claimNextPending's guarded UPDATE), so two runners can't grab the same job.

import { NextResponse } from "next/server";
import { claimNextPending } from "@/lib/website/jobs";
import { checkRunnerToken } from "@/lib/website/runnerAuth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const auth = checkRunnerToken(req.headers.get("x-website-runner-token"));
  if (auth === "unconfigured") return NextResponse.json({ error: "runner_disabled" }, { status: 503 });
  if (auth === "forbidden") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const job = claimNextPending();
  // job === null simply means the queue is empty — a normal, successful poll.
  return NextResponse.json({ ok: true, job });
}
