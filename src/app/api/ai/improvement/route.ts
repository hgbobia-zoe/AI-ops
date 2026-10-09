// Self-Improvement Controller API — open + list improvement runs. Opening a run is a controlled action:
// the responder (x-bridge-token) opens one when it starts work on an improvement request, or an owner/admin
// opens one in the app. A run always has an explicit SCOPE (gate 1) — no scope, no run.

import { NextResponse } from "next/server";
import { openImprovementRun } from "@/lib/ai/improvement/service";
import { listRuns, listActiveRuns, countRunsByState } from "@/lib/ai/improvement/store";
import type { RunScope, RunState } from "@/lib/ai/improvement/types";
import { bridgeTokenValid } from "@/lib/ai/provider";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

async function authed(req: Request): Promise<{ ok: boolean; token: boolean; actor: string }> {
  const token = bridgeTokenValid(req.headers.get("x-bridge-token"));
  if (token) return { ok: true, token: true, actor: "AI responder" };
  if (canManageAi(await viewerRole())) return { ok: true, token: false, actor: (await currentActor()).label };
  return { ok: false, token: false, actor: "" };
}

export async function GET(req: Request): Promise<NextResponse> {
  const a = await authed(req);
  if (!a.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const state = sp.get("state") as RunState | null;
  const active = sp.get("active") === "1";
  const runs = active ? listActiveRuns() : listRuns({ state: state ?? undefined });
  return NextResponse.json({ ok: true, runs, counts: countRunsByState() });
}

export async function POST(req: Request): Promise<NextResponse> {
  const a = await authed(req);
  if (!a.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { requestId?: string; scope?: Partial<RunScope> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const s = body.scope;
  if (!s || !s.blade || !s.summary || !Array.isArray(s.allowedPaths) || s.allowedPaths.length === 0) {
    return NextResponse.json({ error: "scope required: { blade, summary, problem, allowedPaths[], forbiddenPaths[] }" }, { status: 400 });
  }
  const scope: RunScope = {
    blade: s.blade,
    summary: s.summary,
    problem: s.problem ?? "",
    allowedPaths: s.allowedPaths,
    forbiddenPaths: Array.isArray(s.forbiddenPaths) ? s.forbiddenPaths : [],
  };
  const run = openImprovementRun({ requestId: body.requestId ?? null, scope, startedBy: a.actor });
  return NextResponse.json({ ok: true, run });
}
