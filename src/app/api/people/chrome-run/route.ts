// People Lifecycle: start the account setup steps that run in the onboarder's own Chrome (Slack, Quo, work
// email, WeddingPro, Yelp). Owner/admin only (proxy gates /api/people too). Approves each step and returns one
// job per step for the page to hand to the Auto-Pull extension. See src/lib/people/chromeJobs.ts.

import { NextResponse } from "next/server";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageUsers } from "@/lib/auth/roles";
import { startChromeRun } from "@/lib/people/chromeJobs";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { employeeId?: string; taskIds?: string[]; now?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const employeeId = (body.employeeId ?? "").trim();
  if (!employeeId) return NextResponse.json({ error: "employeeId required" }, { status: 400 });
  const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter((x) => typeof x === "string" && x) : undefined;
  const actor = (await currentActor()).label;
  const origin = new URL(req.url).origin;
  const r = await startChromeRun({ employeeId, taskIds, actor, origin, now: body.now === true });
  return NextResponse.json({ ok: true, ...r });
}
