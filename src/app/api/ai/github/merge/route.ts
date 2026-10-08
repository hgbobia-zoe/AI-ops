// In-app PR merge. HUMAN-ONLY: owner/admin cookie, and NO bridge-token path — the AI can never merge a PR
// through the app (audit gate 12). A human clicks Merge in the UI; the server performs it via the GitHub
// API using the fine-grained GITHUB_PR_TOKEN. If a merge improvement-run PR is linked, its run is advanced
// to `merged` too (the state machine still enforces that only ready_to_merge -> merged is legal).

import { NextResponse } from "next/server";
import { mergePr } from "@/lib/ai/github";
import { getRun, listRuns } from "@/lib/ai/improvement/store";
import { recordMerge } from "@/lib/ai/improvement/service";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";
import { insertAudit } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  // Human only — deliberately no x-bridge-token path.
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { number?: number; method?: "squash" | "merge" | "rebase" };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const number = Number(body.number);
  if (!Number.isInteger(number) || number <= 0) return NextResponse.json({ error: "pr number required" }, { status: 400 });
  const method = body.method ?? "squash";
  const actor = (await currentActor()).label;

  const res = await mergePr(number, method);
  try { insertAudit({ actor, action: res.ok ? "GITHUB_PR_MERGED" : "GITHUB_PR_MERGE_FAILED", entity: "github_pr", entityId: String(number), after: { ok: res.ok, error: res.error ?? null } }); } catch { /* best-effort */ }
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error, skipped: res.skipped }, { status: res.skipped ? 409 : 422 });

  // If this PR belongs to an improvement run that's ready to merge, reflect the merge in its lifecycle.
  const linked = listRuns({ limit: 500 }).find((r) => r.prNumber === number && r.state === "ready_to_merge");
  if (linked && getRun(linked.id)) recordMerge(linked.id, { actor, commit: res.sha });

  return NextResponse.json({ ok: true, sha: res.sha });
}
