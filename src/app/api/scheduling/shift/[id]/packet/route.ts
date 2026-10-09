// Build + persist the shift packet for each live assignment on a shift, render the 3 comms touches for a
// dispatcher PREVIEW, and dispatch the requested touch through the gated send path. Owner/admin (it can
// send when SHIFT_COMMS_ENABLED is on). DEFAULT behavior is preview/record-only: with the switch off,
// nothing is sent and packet_sent_at is never set. Honest: send states reflect only what the API reports.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getShiftById } from "@/lib/scheduling/store";
import { getAssignmentsForShift } from "@/lib/scheduling/assignments";
import { isLiveAssignment } from "@/lib/scheduling/lifecycle";
import { renderAllTouches } from "@/lib/scheduling/commsTemplates";
import { buildShiftPacket, type PacketContext, type PacketCoworker } from "@/lib/scheduling/packet";
import { dispatchPacketTouch } from "@/lib/scheduling/packetSend";
import type { CommsTouch } from "@/lib/scheduling/commsTemplates";
import { shiftCommsEnabled } from "@/lib/scheduling/commsFlag";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate, createShiftPass, listShiftPasses } from "@/lib/db/repo";
import { newPassToken } from "@/lib/auth/pass";
import { publicOrigin } from "@/lib/http/origin";
import { readInstaworkSnapshot } from "@/lib/instawork/store";
import { findGigForWorker } from "@/lib/instawork/reconcile";
import { getUsers, type CrewMember } from "@/lib/connecteam";
import type { ShiftAssignment, StaffShift } from "@/lib/scheduling/types";

export const dynamic = "force-dynamic";

const TOUCHES: CommsTouch[] = ["on_assign", "day_before", "refresher"];

/** The worker's delivery-route link for the refresher: a scoped, self-expiring Shift Pass. We REUSE the
 *  existing pass minting (auth/pass + repo). Driver scope with a pre-assigned truck opens straight to the
 *  route checklist; with no truck we fall back to a board (dispatch) view. To avoid a fresh token on every
 *  preview, we reuse a still-live pass already minted for this worker + truck + scope. Returns null only
 *  when we cannot build an absolute origin. */
function mintRoutePass(
  worker: { name: string },
  shift: StaffShift,
  truck: { id: string; name: string } | null,
  origin: string,
  actor: string,
): string | null {
  if (!origin) return null;
  const scope = truck ? "driver" : "board";
  const truckId = truck?.id ?? null;
  const name = worker.name.trim() || "Worker";

  // Reuse an existing live pass for the same worker + truck + scope (keeps repeated previews idempotent).
  const now = Date.now();
  const existing = listShiftPasses().find(
    (p) => !p.revokedAt && Date.parse(p.expiresAt) > now && p.name === name && p.scope === scope && (p.truckId ?? null) === truckId,
  );
  if (existing) return `${origin}/pass/${existing.id}`;

  // Expiry: the shift's end (+3h cushion) when known, else 18h out. Pass self-destructs at that time.
  const endMs = shift.endTime ? Date.parse(shift.endTime) : NaN;
  const expiresMs = Number.isFinite(endMs) ? endMs + 3 * 3_600_000 : now + 18 * 3_600_000;
  const pass = createShiftPass({
    id: newPassToken(),
    name,
    scope,
    truckId,
    truckName: truck?.name ?? null,
    createdBy: actor,
    expiresAt: new Date(expiresMs).toISOString(),
  });
  return `${origin}/pass/${pass.id}`;
}

/** The per-gig Instawork clock codes for one assignee that day (null when the worker can't be tied to a
 *  gig or Instawork sent no codes). Internal workers never carry codes. Match is by name/id + date. */
function instaworkCodes(a: ShiftAssignment, date: string): { clockInCode: string | null; clockOutCode: string | null } {
  if (a.workerKind !== "instawork") return { clockInCode: null, clockOutCode: null };
  const snap = readInstaworkSnapshot();
  if (!snap) return { clockInCode: null, clockOutCode: null };
  const gig = findGigForWorker(snap.shifts, date, { workerName: a.instaworkWorker ?? a.displayName, workerId: null });
  return { clockInCode: gig?.clockInCode ?? null, clockOutCode: gig?.clockOutCode ?? null };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const shift = getShiftById(id);
  if (!shift) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { touch?: CommsTouch } = {};
  try {
    body = (await req.json()) as { touch?: CommsTouch };
  } catch {
    /* no body is fine — defaults to on_assign preview */
  }
  const touch: CommsTouch = body.touch && TOUCHES.includes(body.touch) ? body.touch : "on_assign";

  const live = getAssignmentsForShift(id).filter((a) => isLiveAssignment(a.state));
  const users = await getUsers().catch(() => new Map<number, CrewMember>());
  const actor = (await currentActor()).label;
  const origin = publicOrigin(req);

  // Shared context: truck, route stops, supervisor. Coworkers differ per worker (exclude self).
  const truckName = shift.truckId ? getActiveVehicles().find((v) => v.truckId === shift.truckId)?.name ?? shift.truckId : null;
  const truck = shift.truckId ? { id: shift.truckId, name: truckName as string } : null;
  let route: PacketContext["route"] = null;
  if (shift.routeId && shift.truckId) {
    const r = getRoutesForDate(shift.truckId, shift.date).find((x) => x.routeId === shift.routeId);
    if (r) route = { stops: r.stops.length, firstStop: r.stops[0]?.custName ?? null };
  }
  const supUser = shift.supervisorUserId != null ? users.get(shift.supervisorUserId) : undefined;
  const supervisor = supUser ? { name: supUser.name, phone: supUser.phone ?? null } : null;

  const assignments = [];
  for (const a of live) {
    // Each coworker is the OTHER live assignees, carrying THEIR OWN duty (so a helper sees the driver as a driver).
    const coworkers: PacketCoworker[] = live
      .filter((x) => x.id !== a.id)
      .map((x) => ({ name: x.displayName ?? x.instaworkWorker ?? "Worker", role: x.role }));
    const { clockInCode, clockOutCode } = instaworkCodes(a, shift.date);
    const ctx: PacketContext = { truck, supervisor, coworkers, route, mapUrl: null, equipment: shift.equipment, clockInCode, clockOutCode };
    const workerPhone = a.workerKind === "internal" && a.connecteamUserId != null ? users.get(a.connecteamUserId)?.phone ?? null : null;
    // The delivery-route link rendered in the refresher (reused/minted per worker). null → the line drops.
    const link = mintRoutePass({ name: a.displayName ?? a.instaworkWorker ?? "Worker" }, shift, truck, origin, actor);
    const packet = buildShiftPacket(shift, a, ctx);
    const dispatch = await dispatchPacketTouch({ shift, assignment: a, ctx, touch, workerPhone, link, actor });
    assignments.push({
      assignmentId: a.id,
      displayName: a.displayName ?? a.instaworkWorker ?? "Worker",
      workerKind: a.workerKind,
      version: packet.version,
      touches: renderAllTouches(packet, link),
      dispatch,
    });
  }

  return NextResponse.json({ ok: true, gated: !shiftCommsEnabled(), shiftId: id, touch, assignments });
}
