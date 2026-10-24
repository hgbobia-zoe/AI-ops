// Website Studio — submit + list website-change jobs. POST queues a plain-English request; GET lists the
// caller's recent jobs for the blade. Gated to the marketing-capable roles (canUseWebsiteStudio) — the proxy
// enforces this coarsely too, and we re-check here (defense in depth, mirroring the other blades). Nothing
// here executes a change: it only writes a `pending` row the office runner later drains into a PR.

import { NextResponse } from "next/server";
import { createJob, listJobs } from "@/lib/website/jobs";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canUseWebsiteStudio } from "@/lib/auth/roles";
import { coerceEnvironment } from "@/lib/website/config";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canUseWebsiteStudio(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = await currentActor();
  return NextResponse.json({ ok: true, jobs: listJobs({ requester: actor.label }) });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canUseWebsiteStudio(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { prompt?: string; contextUrl?: string; environment?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return NextResponse.json({ error: "prompt required" }, { status: 400 });
  if (prompt.length > 8000) return NextResponse.json({ error: "prompt too long" }, { status: 400 });

  // Edit context from the embedded browser: the page URL the marketer is looking at + the environment toggle.
  // contextUrl is optional (honest default: none) and length-bounded; environment is coerced to a valid value
  // (defaults to 'production') so a missing/garbage value never fails the submit.
  const contextUrl = (body.contextUrl ?? "").trim();
  if (contextUrl.length > 2000) return NextResponse.json({ error: "contextUrl too long" }, { status: 400 });
  const environment = coerceEnvironment(body.environment);

  const actor = await currentActor();
  const job = createJob({ prompt, requester: actor.label, contextUrl: contextUrl || null, environment });
  if (!job) return NextResponse.json({ error: "could not queue job" }, { status: 500 });
  return NextResponse.json({ ok: true, job });
}
