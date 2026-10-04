// Confirmation scaffold (Lifecycle Phase 4). A dispatcher can confirm a worker is coming (the one
// confirmation signal we can assert today). An inbound-reply confirmation is NOT wired yet, so an
// assignment stays honestly UNVERIFIED until a human confirms or that loop exists. Sets confirmed_at +
// confirm_method, advances the assignment state through the guarded machine, and logs the event.
// Owner/admin gated.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getAssignmentById, updateAssignment, logShiftEvent } from "@/lib/scheduling/assignments";
import { resolveAssignmentTransition } from "@/lib/scheduling/lifecycle";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const a = getAssignmentById(id);
  if (!a) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Only the dispatcher-confirm method is honest today (inbound reply not wired → scaffold).
  const method = "dispatcher";
  const now = new Date().toISOString();
  const nextState = resolveAssignmentTransition(a.state, "CONFIRM"); // valid only from NOTIFIED
  updateAssignment(a.id, { confirmedAt: now, confirmMethod: method, ...(nextState ? { state: nextState } : {}) });
  const actor = (await currentActor()).label;
  logShiftEvent({ shiftId: a.shiftId, assignmentId: a.id, actor, kind: "confirmed", field: "confirm_method", toValue: method, changeKey: `${a.id}:confirmed:${now}` });

  return NextResponse.json({ ok: true, assignmentId: a.id, confirmedAt: now, method, stateAdvanced: Boolean(nextState) });
}
