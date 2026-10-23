// Website Studio — serve a job's preview screenshot to the blade. AUTHED (canUseWebsiteStudio), never public
// — the runner-upload counterpart is token-gated. The label (e.g. "home-desktop") selects which screenshot;
// the bytes come off the Fly volume. Only serves a label that is actually recorded on the job.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canUseWebsiteStudio } from "@/lib/auth/roles";
import { getJob } from "@/lib/website/jobs";
import { readArtifact } from "@/lib/website/artifacts";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canUseWebsiteStudio(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const label = (new URL(req.url).searchParams.get("label") ?? "").trim();
  if (!label) return NextResponse.json({ error: "label required" }, { status: 400 });

  const job = getJob(id);
  if (!job || !job.artifacts.some((a) => a.label === label)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const bytes = readArtifact(id, label);
  if (!bytes) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "image/png", "cache-control": "private, max-age=60" },
  });
}
