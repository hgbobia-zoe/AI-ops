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
import { buildShiftPacket } from "@/lib/scheduling/packet";
import { dispatchPacketTouch } from "@/lib/scheduling/packetSend";
import { buildSharedPacketContext, assignmentPacketInputs } from "@/lib/scheduling/packetDispatch";
import type { CommsTouch } from "@/lib/scheduling/commsTemplates";
import { shiftCommsEnabled } from "@/lib/scheduling/commsFlag";
import { publicOrigin } from "@/lib/http/origin";
import { getUsers, type CrewMember } from "@/lib/connecteam";

export const dynamic = "force-dynamic";

const TOUCHES: CommsTouch[] = ["on_assign", "day_before", "refresher"];

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
  const shared = buildSharedPacketContext(shift, users);

  const assignments = [];
  for (const a of live) {
    const { ctx, workerPhone, link } = assignmentPacketInputs(shift, a, live, shared, users, origin, actor);
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
