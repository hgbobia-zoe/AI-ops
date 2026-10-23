// Website Studio — the office runner watches a specific job here while it WAITS for a human approve/discard
// decision (it holds the job it put into `preview` and polls this until the status becomes `approved` or
// `discarded`). Read-only. Token-gated (WEBSITE_RUNNER_TOKEN via x-website-runner-token), fail-CLOSED.

import { NextResponse } from "next/server";
import { getJob } from "@/lib/website/jobs";
import { checkRunnerToken } from "@/lib/website/runnerAuth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const auth = checkRunnerToken(req.headers.get("x-website-runner-token"));
  if (auth === "unconfigured") return NextResponse.json({ error: "runner_disabled" }, { status: 503 });
  if (auth === "forbidden") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = (new URL(req.url).searchParams.get("id") ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, job });
}
