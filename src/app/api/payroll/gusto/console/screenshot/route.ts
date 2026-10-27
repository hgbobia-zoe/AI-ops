// Gusto remote-browser push — serve the latest live browser frame for a job to the /payroll pane. Owner/admin
// only (the proxy also gates /api/payroll); the office runner's upload route is separate + token-gated. Returns
// the PNG with no-store so the pane's cache-busted <img> always gets the current frame, or 404 before the
// first frame.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { readLiveFrame } from "@/lib/payroll/gustoRunnerArtifacts";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
  const bytes = readLiveFrame(id);
  if (!bytes) return NextResponse.json({ error: "no_frame" }, { status: 404 });
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "image/png", "cache-control": "no-store" },
  });
}
