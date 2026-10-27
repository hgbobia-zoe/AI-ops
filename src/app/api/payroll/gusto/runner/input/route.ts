// Gusto remote-browser push — the office runner drains the pending INTERACTIVE SIGN-IN input for a job here
// (Phase 2) and replays it into the live Gusto login page. Token-gated, fail-CLOSED, like the other runner
// endpoints. Claim-once: each event is returned exactly once (the store marks it consumed in the same
// transaction). The runner only ever calls this while the job is signin_required and the page is a gusto.com
// auth screen — the DRAFT write is fully automated and never takes forwarded input.

import { NextResponse } from "next/server";
import { claimInputs } from "@/lib/payroll/gustoRunnerJobs";
import { checkGustoRunnerToken } from "@/lib/payroll/gustoRunnerAuth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const auth = checkGustoRunnerToken(req.headers.get("x-gusto-runner-token"));
  if (auth === "unconfigured") return NextResponse.json({ error: "runner_disabled" }, { status: 503 });
  if (auth === "forbidden") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
  return NextResponse.json({ ok: true, events: claimInputs(id) });
}
