// Website Studio — the office runner uploads a preview screenshot here (PNG) for a job. Multipart form:
// { jobId, label (e.g. "home-desktop"), file }. Bytes are saved to the Fly volume and the artifact ref is
// recorded on the job (only while it is running/preview). Token-gated (WEBSITE_RUNNER_TOKEN via
// x-website-runner-token), fail-CLOSED. The blade serves these back through the AUTHED
// /api/website/jobs/[id]/artifact route (never public).

import { NextResponse } from "next/server";
import { addJobArtifact } from "@/lib/website/jobs";
import { saveArtifact } from "@/lib/website/artifacts";
import { checkRunnerToken } from "@/lib/website/runnerAuth";

export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024; // a screenshot PNG; generous but bounded

export async function POST(req: Request): Promise<NextResponse> {
  const auth = checkRunnerToken(req.headers.get("x-website-runner-token"));
  if (auth === "unconfigured") return NextResponse.json({ error: "runner_disabled" }, { status: 503 });
  if (auth === "forbidden") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  const jobId = String(form.get("jobId") ?? "").trim();
  const label = String(form.get("label") ?? "").trim();
  const file = form.get("file");
  if (!jobId || !label) return NextResponse.json({ error: "jobId and label required" }, { status: 400 });
  if (!(file instanceof Blob)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const storedPath = saveArtifact(jobId, label, bytes);
    const job = addJobArtifact(jobId, { label, path: storedPath });
    if (!job) return NextResponse.json({ error: "job not accepting artifacts" }, { status: 409 });
    return NextResponse.json({ ok: true, job });
  } catch {
    return NextResponse.json({ error: "could not store artifact" }, { status: 500 });
  }
}
