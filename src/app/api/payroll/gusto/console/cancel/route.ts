// Gusto remote-browser push — cancel the in-flight push from the app (owner/admin; proxy also gates
// /api/payroll). Flips the job to 'canceled'; the office runner polls the job and stops when it sees that.
// Only a queued/active job can be canceled.

import { NextResponse } from "next/server";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { cancelJob } from "@/lib/payroll/gustoRunnerJobs";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const actor = await currentActor();
  const job = cancelJob(id, actor.label);
  if (!job) return NextResponse.json({ error: "Job can't be canceled (already finished?)." }, { status: 409 });
  return NextResponse.json({ ok: true, job });
}
