// Scheduling — update or delete one shift. Staff-only (proxy denies guests + requires a session on
// /api/*). Next.js 16: `params` is a Promise, so it's awaited.

import { NextResponse } from "next/server";
import { updateShift, deleteShift, type ShiftPatch } from "@/lib/scheduling/store";
import { syncInternalAssignments } from "@/lib/scheduling/assignments";
import { currentActor } from "@/lib/auth/getSession";
import { getUsers } from "@/lib/connecteam";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  let body: ShiftPatch;
  try {
    body = (await req.json()) as ShiftPatch;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const shift = updateShift(id, body);
  if (!shift) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Live dual-write (migration I): keep the per-worker shift_assignments rows in lock-step with the
  // staff_shifts.assignees the board edits, so readiness/exceptions compute over real assignments. Names
  // are resolved from Connecteam best-effort; a Connecteam outage leaves display_name null (never blocks
  // the assign). Only runs when the assignees set actually changed.
  if ("assignees" in body && Array.isArray(body.assignees)) {
    let nameOf: (userId: number) => string | null = () => null;
    try {
      const users = await getUsers();
      nameOf = (uid) => users.get(uid)?.name ?? null;
    } catch {
      /* Connecteam unreachable — keep display_name null, fill on a later tick. */
    }
    try {
      const actor = (await currentActor()).label;
      syncInternalAssignments(shift, shift.assignees, nameOf, actor);
    } catch {
      /* A sync failure must not fail the assign (assignees is the SoR the board reads). */
    }
  }

  return NextResponse.json({ ok: true, shift });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  deleteShift(id);
  return NextResponse.json({ ok: true });
}
