// Gusto remote-browser push — the office runner uploads the CURRENT live frame of its Gusto browser here (PNG)
// so the /payroll Gusto Console can show the remote browser. Multipart form: { jobId, file }. The frame is
// saved to the Fly volume (one per job, overwritten) and the job is stamped (screenshot ref + updated_at) so
// the pane's cache-busted <img> refreshes. Token-gated (GUSTO_RUNNER_TOKEN), fail-CLOSED. The pane reads the
// frame back through the AUTHED /api/payroll/gusto/console/screenshot route (never public).

import { NextResponse } from "next/server";
import { reportProgress } from "@/lib/payroll/gustoRunnerJobs";
import { saveLiveFrame } from "@/lib/payroll/gustoRunnerArtifacts";
import { checkGustoRunnerToken } from "@/lib/payroll/gustoRunnerAuth";

export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024; // a screenshot PNG; generous but bounded

export async function POST(req: Request): Promise<NextResponse> {
  const auth = checkGustoRunnerToken(req.headers.get("x-gusto-runner-token"));
  if (auth === "unconfigured") return NextResponse.json({ error: "runner_disabled" }, { status: 503 });
  if (auth === "forbidden") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  const jobId = String(form.get("jobId") ?? "").trim();
  const phase = String(form.get("phase") ?? "").trim() || null;
  const file = form.get("file");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  if (!(file instanceof Blob)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    saveLiveFrame(jobId, bytes);
    // Stamp the job so the pane knows a fresh frame exists (and refresh an optional phase label). Only an
    // active job accepts a frame — a terminal/canceled job returns null and the runner learns to stop.
    const job = reportProgress(jobId, { screenshot: "live.png", phase });
    if (!job) return NextResponse.json({ ok: false, reason: "job not active" }, { status: 200 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "could not store frame" }, { status: 500 });
  }
}
