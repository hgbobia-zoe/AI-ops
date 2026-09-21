// Post-Event project detail — the full reconstructed journey for one project. GET returns the workflow
// row, the referenced Goodshuffle facts, contacts, reviews, issues, the transition log, the assembled
// timeline, and the config (review template/destination). PATCH sets the human-owned fields (experience
// disposition, assigned employee). Setting a disposition recomputes the next action deterministically.

import { NextResponse } from "next/server";
import { getProject, listContacts, listReviews, listIssues, getTransitions, getConfig, setDisposition, setAssignee, setNextAction } from "@/lib/postevent/store";
import { projectFacts, buildTimeline, deriveNextAction } from "@/lib/postevent/engine";
import { openIssueCounts } from "@/lib/postevent/store";
import { DISPOSITION_ORDER, type Disposition } from "@/lib/postevent/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({
    project,
    facts: projectFacts(id),
    contacts: listContacts(id),
    reviews: listReviews(id),
    issues: listIssues(id),
    transitions: getTransitions(id),
    timeline: buildTimeline(id),
    config: getConfig(),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let body: { disposition?: Disposition | null; assignedEmployee?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.disposition !== undefined) {
    if (body.disposition !== null && !(DISPOSITION_ORDER as string[]).includes(body.disposition)) return NextResponse.json({ error: "bad_disposition" }, { status: 400 });
    setDisposition(id, body.disposition);
  }
  if (body.assignedEmployee !== undefined) setAssignee(id, body.assignedEmployee);

  // Recompute next action after any disposition change.
  const fresh = getProject(id)!;
  setNextAction(id, deriveNextAction(fresh.state, fresh.disposition, openIssueCounts().get(id) ?? 0));
  return NextResponse.json({ ok: true, project: getProject(id) });
}
