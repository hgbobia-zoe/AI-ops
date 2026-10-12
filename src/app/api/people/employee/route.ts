// People Lifecycle — employee create + lifecycle transitions. Owner/admin only (canManageUsers; the proxy
// also gates /api/people). This is a thin wrapper over the pure engine: the machine guards every
// transition, the engine materializes tasks + audits. Nothing new executes here.

import { NextResponse } from "next/server";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageUsers, isRole } from "@/lib/auth/roles";
import {
  activate,
  advanceToReady,
  completeOffboarding,
  startOffboarding,
  startOnboarding,
} from "@/lib/people/lifecycle";
import { createEmployee } from "@/lib/people/store";

export const dynamic = "force-dynamic";

type Action = "create" | "start_onboarding" | "advance_ready" | "activate" | "start_offboarding" | "complete_offboarding";
const ACTIONS: Action[] = ["create", "start_onboarding", "advance_ready", "activate", "start_offboarding", "complete_offboarding"];

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: {
    action?: string;
    id?: string;
    displayName?: string;
    workEmail?: string;
    role?: string;
    department?: string;
    startDate?: string;
    effectiveDate?: string | null;
    startNow?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const action = body.action as Action | undefined;
  if (!action || !ACTIONS.includes(action)) return NextResponse.json({ error: "bad_action" }, { status: 400 });
  const actor = (await currentActor()).label;

  if (action === "create") {
    const name = (body.displayName ?? "").trim();
    if (!name) return NextResponse.json({ error: "displayName required" }, { status: 400 });
    const empRole = isRole(body.role) && body.role !== "guest" ? body.role : "member";
    const emp = createEmployee({
      displayName: name,
      workEmail: body.workEmail ?? null,
      role: empRole,
      department: body.department ?? null,
      startDate: body.startDate ?? null,
    });
    // Convenience: optionally kick off onboarding immediately on create.
    if (body.startNow) startOnboarding(emp.id, actor);
    return NextResponse.json({ ok: true, id: emp.id });
  }

  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const result =
    action === "start_onboarding" ? startOnboarding(id, actor)
    : action === "advance_ready" ? advanceToReady(id, actor)
    : action === "activate" ? activate(id, actor)
    : action === "start_offboarding" ? startOffboarding(id, actor, body.effectiveDate ?? null)
    : completeOffboarding(id, actor);

  return NextResponse.json({ ok: result.ok, state: result.state, message: result.message }, { status: result.ok ? 200 : 409 });
}
