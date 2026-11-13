// Scheduling — update or delete one shift. Staff-only (proxy denies guests + requires a session on
// /api/*). Next.js 16: `params` is a Promise, so it's awaited.

import { NextResponse } from "next/server";
import { updateShift, deleteShift, getShiftById, getShiftsForDate, type ShiftPatch } from "@/lib/scheduling/store";
import { overrideAfterEdit } from "@/lib/scheduling/routeMatch";
import { crewWindowForRoute } from "@/lib/scheduling/routeCrewWindow";
import { syncInternalAssignments, getAssignmentsForShift, updateAssignment, logShiftEvent } from "@/lib/scheduling/assignments";
import { isLiveAssignment } from "@/lib/scheduling/lifecycle";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getUsers, deletePublishedShift, getDefaultScheduler } from "@/lib/connecteam";
import { pullFromConnecteam, UNLINKED, type PullDeps } from "@/lib/scheduling/pullFromConnecteam";
import { insertAudit } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

const pullDeps: PullDeps = {
  deleteShift: (input) => deletePublishedShift(input),
  defaultSchedulerId: async () => (await getDefaultScheduler())?.schedulerId ?? null,
};

/** Cancelled and deleted shifts are pulled from Connecteam (pullFromConnecteam.ts). Owner/admin only, like
 *  Publish, because it notifies the crew. `refuse` is the response to send when it can't go ahead. */
async function pullOrRefuse(shift: NonNullable<ReturnType<typeof getShiftById>>, what: "cancel" | "delete"): Promise<{ refuse: NextResponse } | { removed: boolean }> {
  if (!shift.connecteamShiftId) return { removed: false };
  if (!canManageSettings(await viewerRole())) {
    return { refuse: NextResponse.json({ error: "forbidden", message: `Only an owner or admin can ${what} a shift that is in Connecteam.` }, { status: 403 }) };
  }
  const r = await pullFromConnecteam(shift, getShiftsForDate(shift.date), pullDeps);
  const actor = (await currentActor()).label;
  try {
    insertAudit({ actor, action: r.ok ? `SHIFT_${what.toUpperCase()}_CONNECTEAM_${r.reason.toUpperCase()}` : `SHIFT_${what.toUpperCase()}_CONNECTEAM_FAILED`, entity: "staff_shift", entityId: shift.id, after: { connecteamShiftId: shift.connecteamShiftId, ...(r.ok ? {} : { error: r.error }) } });
  } catch {
    /* audit must never block */
  }
  if (!r.ok) return { refuse: NextResponse.json({ error: "connecteam_failed", message: r.error }, { status: 502 }) };
  return { removed: r.removed };
}

/** The PATCH body is a ShiftPatch, plus an optional dispatcher-override reason. A manual assignment
 *  change ALWAYS wins (the optimizer never auto-runs to fight it); overrideReason records WHY, for audit. */
type PatchBody = ShiftPatch & {
  overrideReason?: string;
  /** "reset" = Reset to route (route time, override cleared). "keep" = Keep this time (record an override). */
  routeTimeAction?: "reset" | "keep";
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { overrideReason, routeTimeAction, ...rawPatch } = body;
  // Route bookkeeping is server owned: a client never writes the override or the route window directly.
  const { routeOverride: _o, routeWindowStart: _s, routeWindowEnd: _e, ...patch } = rawPatch;
  void _o; void _s; void _e;

  // Shifts match the route unless someone overrides it (routeMatch.ts): a person changing a route shift's
  // time here is an explicit override (who, when, the route time it replaced). Setting it back to the
  // route's time clears it.
  const before = getShiftById(id);
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (routeTimeAction === "reset" || routeTimeAction === "keep") {
    const crew = crewWindowForRoute(before.routeId);
    if (!before.routeId || !crew.known || !crew.start || !crew.end) return NextResponse.json({ error: "no_route_time", message: "This shift's route has no stop times yet." }, { status: 400 });
    const actor = (await currentActor()).label;
    const now = new Date().toISOString();
    // Reset puts the shift back on the route here in Dispatch. A shift already in Connecteam is sent there by the
    // usual Publish button (owner/admin), so nothing published changes without a person sending it.
    const result = routeTimeAction === "reset"
      ? updateShift(id, { startTime: crew.start, endTime: crew.end, windowKnown: true, routeOverride: null, routeWindowStart: crew.start, routeWindowEnd: crew.end })
      : updateShift(id, { routeOverride: { by: actor, at: now, source: "kept", routeStart: crew.start, routeEnd: crew.end }, routeWindowStart: crew.start, routeWindowEnd: crew.end });
    logShiftEvent({ shiftId: id, actor, kind: routeTimeAction === "reset" ? "route_time_reset" : "route_time_kept", field: "time", toValue: routeTimeAction === "reset" ? `${crew.start} to ${crew.end}` : `${before.startTime} to ${before.endTime}`, changeKey: `${id}:route_time:${Date.now()}` });
    return NextResponse.json({ ok: true, shift: result });
  }
  if (patch.status === "cancelled" && before.status !== "cancelled") {
    const pulled = await pullOrRefuse(before, "cancel");
    if ("refuse" in pulled) return pulled.refuse;
    if (pulled.removed) Object.assign(patch, UNLINKED, { connecteamSyncedAt: new Date().toISOString() });
  }
  if (("startTime" in patch || "endTime" in patch) && before.routeId) {
    const next = { startTime: "startTime" in patch ? patch.startTime ?? null : before.startTime, endTime: "endTime" in patch ? patch.endTime ?? null : before.endTime };
    const ov = overrideAfterEdit(before, next, crewWindowForRoute(before.routeId), (await currentActor()).label, new Date().toISOString());
    if (ov) Object.assign(patch, ov);
  }
  const shift = updateShift(id, patch);
  if (!shift) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Live dual-write (migration I): keep the per-worker shift_assignments rows in lock-step with the
  // staff_shifts.assignees the board edits, so readiness/exceptions compute over real assignments. Names
  // are resolved from Connecteam best-effort; a Connecteam outage leaves display_name null (never blocks
  // the assign). Only runs when the assignees set actually changed.
  if ("assignees" in patch && Array.isArray(patch.assignees)) {
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
      // Dispatcher OVERRIDE: a manual change the dispatcher flags as overriding the optimizer. Record it
      // on every live internal row + an audit event. Manual always wins — this only annotates why.
      if (overrideReason && overrideReason.trim()) {
        const reason = overrideReason.trim().slice(0, 500);
        for (const a of getAssignmentsForShift(shift.id)) {
          if (a.workerKind !== "internal" || !isLiveAssignment(a.state)) continue;
          updateAssignment(a.id, { overridden: true, overrideReason: reason });
        }
        logShiftEvent({ shiftId: shift.id, actor, kind: "override", field: "assignees", toValue: reason, changeKey: `${shift.id}:override:${Date.now()}` });
      }
    } catch {
      /* A sync failure must not fail the assign (assignees is the SoR the board reads). */
    }
  }

  return NextResponse.json({ ok: true, shift });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const before = getShiftById(id);
  if (before) {
    const pulled = await pullOrRefuse(before, "delete");
    if ("refuse" in pulled) return pulled.refuse;
  }
  deleteShift(id);
  return NextResponse.json({ ok: true });
}
