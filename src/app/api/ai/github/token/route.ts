// In-app GitHub token setup. Owner/admin only, NO bridge-token path. The human pastes a GitHub token in the
// Pull Requests panel; the app stores it WRITE-ONLY in its own secret store (never returned to the client).
// This is the in-app way to connect merging without a terminal or GitHub settings. Prefer a fine-grained
// PAT (Pull requests: read/write on this repo only) over a broad token — see docs/self-improvement-setup.md.

import { NextResponse } from "next/server";
import { setSecret } from "@/lib/secrets";
import { githubMergeConfigured } from "@/lib/ai/github";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";
import { insertAudit } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { token?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const token = (body.token ?? "").trim();
  if (!token || token.length < 20) return NextResponse.json({ error: "that doesn't look like a valid token" }, { status: 400 });
  setSecret("github.prToken", token);
  try { insertAudit({ actor: (await currentActor()).label, action: "GITHUB_TOKEN_SET", entity: "settings", entityId: "github.prToken", after: { set: true } }); } catch { /* best-effort */ }
  return NextResponse.json({ ok: true, configured: githubMergeConfigured() });
}

export async function DELETE(): Promise<NextResponse> {
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  setSecret("github.prToken", null);
  return NextResponse.json({ ok: true, configured: false });
}
