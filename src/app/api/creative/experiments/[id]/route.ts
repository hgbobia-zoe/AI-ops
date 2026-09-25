// Provider Benchmarking — one experiment. GET returns the full detail bundle (experiment + matrix + evals +
// reused generations + computed metrics), syncing run status from any async callbacks that have landed.
// PATCH transitions the lifecycle (complete / archive / reopen). Polled by the detail view while running.

import { NextResponse } from "next/server";
import { getExperiment } from "@/lib/creative/experimentStore";
import { buildDetail, transitionExperiment } from "@/lib/creative/experimentService";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const detail = buildDetail(id);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(detail);
}

interface Body {
  action?: "complete" | "archive" | "reopen";
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  if (!getExperiment(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const to = body.action === "complete" ? "completed" : body.action === "archive" ? "archived" : body.action === "reopen" ? "running" : null;
  if (!to) return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  const experiment = transitionExperiment(id, to);
  return NextResponse.json({ ok: !!experiment, experiment });
}
