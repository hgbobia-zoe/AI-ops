// Provider Benchmarking — human evaluation + paired preference. Two actions:
//   { action: "eval", runId, criteria…, overallApproval, decision, notes, failures[] }  → per-image eval
//   { action: "preference", caseId, choice: runId|"both"|"neither", note }               → paired preference
// The human evaluation is stored SEPARATELY from the automated QA and never blended into a single score.

import { NextResponse } from "next/server";
import { getExperiment } from "@/lib/creative/experimentStore";
import { submitRunEval, setCasePreferenceChoice, buildDetail } from "@/lib/creative/experimentService";
import { currentActor } from "@/lib/auth/getSession";
import type { EvalInput } from "@/lib/creative/experimentStore";
import type { Verdict, EvalDecision } from "@/lib/creative/experimentTypes";

export const dynamic = "force-dynamic";

const verdict = (v: unknown): Verdict | null => (v === "pass" || v === "fail" ? v : null);
const decision = (v: unknown): EvalDecision | null => (v === "approve" || v === "reject" || v === "needs_revision" ? v : null);

interface Body {
  action?: "eval" | "preference";
  // eval
  runId?: string;
  productAccuracy?: unknown;
  realism?: unknown;
  brandFit?: unknown;
  composition?: unknown;
  usability?: unknown;
  overallApproval?: unknown;
  decision?: unknown;
  notes?: string | null;
  failures?: { category?: string; note?: string | null }[];
  // preference
  caseId?: string;
  choice?: string | null;
  note?: string | null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  if (!getExperiment(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const actor = (await currentActor()).label;

  if (body.action === "preference") {
    if (!body.caseId) return NextResponse.json({ error: "caseId_required" }, { status: 400 });
    const res = setCasePreferenceChoice(id, body.caseId, body.choice ?? null, body.note ?? null, actor);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json({ ok: true, ...(buildDetail(id) ?? {}) });
  }

  // default: eval
  if (!body.runId) return NextResponse.json({ error: "runId_required" }, { status: 400 });
  const input: EvalInput = {
    productAccuracy: verdict(body.productAccuracy),
    realism: verdict(body.realism),
    brandFit: verdict(body.brandFit),
    composition: verdict(body.composition),
    usability: verdict(body.usability),
    overallApproval: verdict(body.overallApproval),
    decision: decision(body.decision),
    notes: typeof body.notes === "string" ? body.notes : null,
  };
  const failures = Array.isArray(body.failures) ? body.failures.map((f) => ({ category: String(f.category ?? ""), note: f.note ?? null })) : [];
  const res = submitRunEval(id, body.runId, input, failures, actor);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, ...(buildDetail(id) ?? {}) });
}
