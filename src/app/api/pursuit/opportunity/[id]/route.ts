// Bid pursuit workspace API — the review-ready package + human-owned state for one opportunity.
// Owner/Admin only (proxy gates /api/pursuit as settings; re-checked here). GET returns the generated
// package + saved state. POST op "save" persists human edits (stamps who/when on SUBMITTED); op "refine"
// returns an AI-refined narrative WITHOUT saving (the human keeps it by editing + saving). Never submits.

import { NextResponse } from "next/server";
import { buildBidPackage, refineBidNarrative } from "@/lib/pursuit/bidPackage";
import { getPursuitState, savePursuitState, type PursuitSaveInput } from "@/lib/pursuit/pursuitState";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const pkg = buildBidPackage(id);
  if (!pkg) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ package: pkg, state: getPursuitState(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const pkg = buildBidPackage(id);
  if (!pkg) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { op?: string; state?: PursuitSaveInput };
  try {
    body = (await req.json()) as { op?: string; state?: PursuitSaveInput };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.op === "refine") {
    const refined = await refineBidNarrative(pkg);
    return NextResponse.json({ refined });
  }

  if (body.op === "save") {
    const input: PursuitSaveInput = { ...(body.state ?? {}) };
    if (input.status === "SUBMITTED") input.submittedBy = (await currentActor()).label;
    const state = savePursuitState(id, input);
    return NextResponse.json({ ok: true, state });
  }

  return NextResponse.json({ error: "unknown_op" }, { status: 400 });
}
