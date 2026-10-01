// Publish a built shift to Connecteam — the "send it to the crew" step. Creates a PUBLISHED Connecteam
// shift (notifies the assigned crew) for the internal assignees. Human-gated: owner/admin only, the shift
// must already be CONFIRMED, have a real time window, and have at least one internal assignee. Idempotent:
// a shift already carrying a connecteamShiftId is never published twice. The Instawork gap is a separate
// (later) step — this sends only the internal half.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getShiftById, updateShift } from "@/lib/scheduling/store";
import { createPublishedShift, getDefaultScheduler } from "@/lib/connecteam";
import type { ShiftRole } from "@/lib/scheduling/types";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<ShiftRole, string> = { driver: "Driver", field: "Field", prep: "Prep" };

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const shift = getShiftById(id);
  if (!shift) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Idempotent — never double-publish.
  if (shift.connecteamShiftId) {
    return NextResponse.json({ ok: true, alreadyPublished: true, connecteamShiftId: shift.connecteamShiftId });
  }

  // Human-approval + data gates.
  if (shift.status !== "confirmed") {
    return NextResponse.json({ error: "confirm_first", message: "Confirm the shift before sending it to the crew." }, { status: 409 });
  }
  if (!shift.windowKnown || !shift.startTime || !shift.endTime) {
    return NextResponse.json({ error: "no_window", message: "Set a start and end time first." }, { status: 400 });
  }
  if (shift.assignees.length === 0) {
    return NextResponse.json({ error: "no_assignees", message: "Assign internal crew before publishing (the Instawork gap is sent separately)." }, { status: 400 });
  }

  const scheduler = await getDefaultScheduler();
  if (!scheduler) {
    return NextResponse.json({ error: "no_scheduler", message: "No Connecteam scheduler is reachable." }, { status: 400 });
  }

  const startUnix = Math.floor(Date.parse(shift.startTime) / 1000);
  const endUnix = Math.floor(Date.parse(shift.endTime) / 1000);
  if (!startUnix || !endUnix || endUnix <= startUnix) {
    return NextResponse.json({ error: "bad_time", message: "The shift's time window is invalid." }, { status: 400 });
  }

  const title = `${ROLE_LABEL[shift.role]} — ${shift.eventLabel || shift.date}`;
  const result = await createPublishedShift({
    schedulerId: scheduler.schedulerId,
    title,
    startUnix,
    endUnix,
    timezone: scheduler.timezone,
    assignedUserIds: shift.assignees,
  });

  if (!result.ok) {
    return NextResponse.json({ error: "connecteam_failed", message: result.error ?? "Connecteam rejected the shift." }, { status: 502 });
  }

  updateShift(id, {
    status: "sent",
    connecteamShiftId: result.shiftId ?? `ct-${Date.now()}`,
    connecteamSchedulerId: scheduler.schedulerId,
    connecteamPublishedAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, connecteamShiftId: result.shiftId ?? null, notified: shift.assignees.length });
}
