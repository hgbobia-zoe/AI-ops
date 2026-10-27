// Gusto remote-browser push — the office runner polls the CURRENT state of a job it is processing here, so it
// can stop early when a human cancels it from the app (status 'canceled'). Token-gated, fail-CLOSED, like the
// other runner endpoints. Read-only.

import { NextResponse } from "next/server";
import { getJob } from "@/lib/payroll/gustoRunnerJobs";
import { checkGustoRunnerToken } from "@/lib/payroll/gustoRunnerAuth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const auth = checkGustoRunnerToken(req.headers.get("x-gusto-runner-token"));
  if (auth === "unconfigured") return NextResponse.json({ error: "runner_disabled" }, { status: 503 });
  if (auth === "forbidden") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
  return NextResponse.json({ ok: true, job: getJob(id) });
}
