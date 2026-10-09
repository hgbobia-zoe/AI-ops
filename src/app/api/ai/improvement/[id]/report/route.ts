// Self-Improvement Controller API — the step-report interface. The AI responder (x-bridge-token) reports
// each step here and the CONTROLLER applies the rule: a guarded transition, the scope gate, the budget
// gate, bounded self-repair, or the verify→rollback routing. The AI cannot move a run or skip a gate; it
// can only report, and the controller decides. Owner/admin may also drive a run from the UI (e.g. resume a
// human_review_required run).

import { NextResponse } from "next/server";
import {
  advance, recordPlan, enforceScope, enforceBudget, reportValidation, reportCi, retryRepair, recordMerge, verifyAndRoute,
} from "@/lib/ai/improvement/service";
import { getRun, setRunArtifacts } from "@/lib/ai/improvement/store";
import type { RunState } from "@/lib/ai/improvement/types";
import { bridgeTokenValid } from "@/lib/ai/provider";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const APP_BASE_URL = process.env.APP_BASE_URL || "https://zoe-dispatch.fly.dev";
const GITHUB_REPO = process.env.GITHUB_REPO || "hgbobia-zoe/AI-ops";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const token = bridgeTokenValid(req.headers.get("x-bridge-token"));
  const manager = canManageAi(await viewerRole());
  if (!token && !manager) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = token ? "AI responder" : (await currentActor()).label;

  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: {
    op?: string; to?: string; plan?: string; changedPaths?: string[];
    metrics?: Record<string, number>; passed?: boolean; note?: string;
    branch?: string; commit?: string; prUrl?: string; prNumber?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  switch (body.op) {
    case "plan": {
      if (!body.plan?.trim()) return NextResponse.json({ error: "plan required" }, { status: 400 });
      const t = recordPlan(id, body.plan.trim(), actor);
      return respond(t.ok, id, t.error);
    }
    case "advance": {
      if (!body.to) return NextResponse.json({ error: "to required" }, { status: 400 });
      const t = advance(id, body.to as RunState, { actor, note: body.note });
      return respond(t.ok, id, t.error);
    }
    case "artifacts": {
      setRunArtifacts(id, { branch: body.branch, commit: body.commit, prUrl: body.prUrl, prNumber: body.prNumber });
      return respond(true, id);
    }
    case "scope": {
      const r = enforceScope(id, Array.isArray(body.changedPaths) ? body.changedPaths : []);
      return NextResponse.json({ ok: r.ok, enforcement: r, run: getRun(id) });
    }
    case "budget": {
      const r = enforceBudget(id, (body.metrics ?? {}) as Record<string, number>);
      return NextResponse.json({ ok: r.ok, enforcement: r, run: getRun(id) });
    }
    case "validation": {
      const t = reportValidation(id, body.passed === true, body.note);
      return respond(t.ok, id, t.error);
    }
    case "ci": {
      const t = reportCi(id, body.passed === true, body.note);
      return respond(t.ok, id, t.error);
    }
    case "retry": {
      const t = retryRepair(id);
      return respond(t.ok, id, t.error);
    }
    case "merge": {
      // Recording a merge: the controller never auto-merges unless autonomy.autoMerge is on; a human merge
      // is recorded here after the fact. The state machine still guarantees only ready_to_merge -> merged.
      const t = recordMerge(id, { actor, commit: body.commit });
      return respond(t.ok, id, t.error);
    }
    case "verify": {
      const outcome = await verifyAndRoute(id, APP_BASE_URL, GITHUB_REPO);
      return NextResponse.json({ ok: true, outcome, run: getRun(id) });
    }
    default:
      return NextResponse.json({ error: "bad_op" }, { status: 400 });
  }
}

function respond(ok: boolean, id: string, error?: string): NextResponse {
  if (!ok) return NextResponse.json({ ok: false, error: error ?? "refused", run: getRun(id) }, { status: 409 });
  return NextResponse.json({ ok: true, run: getRun(id) });
}
