// In-app GitHub PR list. Owner/admin only (reviewing/merging is a human governance action). Returns open
// PRs with a simple checks verdict so a human can merge from inside the app instead of going to GitHub.

import { NextResponse } from "next/server";
import { listOpenPrs, githubMergeConfigured, githubRepo } from "@/lib/ai/github";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!githubMergeConfigured()) return NextResponse.json({ ok: true, configured: false, repo: githubRepo(), prs: [] });
  return NextResponse.json({ ok: true, configured: true, repo: githubRepo(), prs: await listOpenPrs() });
}
