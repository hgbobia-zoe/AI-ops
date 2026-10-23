// Website Studio — the office runner posts a claimed job's progress here:
//   status "preview" — edits + local render + screenshots done; carries the agent summary, changed repo
//                       files, and changed site page paths (screenshots are uploaded separately to
//                       /api/website/runner/artifact). Moves running → preview, then the runner WAITS for a
//                       human approve/discard (polled via /api/website/runner/job).
//   status "done"    — the branch was pushed + a PR opened (carries prUrl). Moves approved → done.
//   status "failed"  — the runner hit an error (carries a short reason). From running or approved.
// Token-gated (WEBSITE_RUNNER_TOKEN via x-website-runner-token), fail-CLOSED (503 until configured). The
// store only transitions the expected prior state, so a stale/duplicate POST is a safe no-op (409).

import { NextResponse } from "next/server";
import { setJobPreview, completeJob, failJob } from "@/lib/website/jobs";
import { checkRunnerToken } from "@/lib/website/runnerAuth";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const auth = checkRunnerToken(req.headers.get("x-website-runner-token"));
  if (auth === "unconfigured") return NextResponse.json({ error: "runner_disabled" }, { status: 503 });
  if (auth === "forbidden") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    id?: string;
    status?: string;
    summary?: string;
    changedFiles?: unknown;
    pagePaths?: unknown;
    prUrl?: string;
    error?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

  if (body.status === "preview") {
    const job = setJobPreview(id, {
      summary: body.summary ?? null,
      changedFiles: asStrings(body.changedFiles),
      pagePaths: asStrings(body.pagePaths),
    });
    if (!job) return NextResponse.json({ error: "not_running_or_missing" }, { status: 409 });
    return NextResponse.json({ ok: true, job });
  }
  if (body.status === "done") {
    const job = completeJob(id, { summary: body.summary ?? null, prUrl: body.prUrl ?? null });
    if (!job) return NextResponse.json({ error: "not_approved_or_missing" }, { status: 409 });
    return NextResponse.json({ ok: true, job });
  }
  if (body.status === "failed") {
    const job = failJob(id, body.error ?? "unknown error");
    if (!job) return NextResponse.json({ error: "not_failable_or_missing" }, { status: 409 });
    return NextResponse.json({ ok: true, job });
  }
  return NextResponse.json({ error: "status must be 'preview', 'done', or 'failed'" }, { status: 400 });
}
