// Publish a built shift to Connecteam — the "send it to the crew" step. Creates a PUBLISHED Connecteam
// shift (notifies the assigned crew) for the internal assignees. Human-gated: owner/admin only, the shift
// must already be CONFIRMED, have a real time window, and have at least one internal assignee. Idempotent:
// a shift already carrying a connecteamShiftId is never published twice. The Instawork gap is a separate
// (later) step — this sends only the internal half.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getShiftById, updateShift } from "@/lib/scheduling/store";
import { createPublishedShift, updatePublishedShift, getDefaultScheduler, getSchedulers } from "@/lib/connecteam";
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

  const isUpdate = Boolean(shift.connecteamShiftId);

  // Human-approval + data gates (apply to both first publish and re-publish of an edited shift).
  if (shift.status !== "confirmed") {
    return NextResponse.json({ error: "confirm_first", message: "Confirm the shift before sending it to the crew." }, { status: 409 });
  }
  if (!shift.windowKnown || !shift.startTime || !shift.endTime) {
    return NextResponse.json({ error: "no_window", message: "Set a start and end time first." }, { status: 400 });
  }
  if (shift.assignees.length === 0) {
    return NextResponse.json({ error: "no_assignees", message: "Assign internal crew before publishing (the Instawork gap is sent separately)." }, { status: 400 });
  }

  // On an update, stay on the scheduler the shift was first published to; else pick the default.
  const scheduler = isUpdate && shift.connecteamSchedulerId
    ? (await getSchedulers()).find((s) => s.schedulerId === shift.connecteamSchedulerId) ?? (await getDefaultScheduler())
    : await getDefaultScheduler();
  if (!scheduler) {
    return NextResponse.json({ error: "no_scheduler", message: "No Connecteam scheduler is reachable." }, { status: 400 });
  }

  const startUnix = Math.floor(Date.parse(shift.startTime) / 1000);
  const endUnix = Math.floor(Date.parse(shift.endTime) / 1000);
  if (!startUnix || !endUnix || endUnix <= startUnix) {
    return NextResponse.json({ error: "bad_time", message: "The shift's time window is invalid." }, { status: 400 });
  }

  const input = {
    schedulerId: scheduler.schedulerId,
    title: `${ROLE_LABEL[shift.role]} — ${shift.eventLabel || shift.date}`,
    startUnix,
    endUnix,
    timezone: scheduler.timezone,
    assignedUserIds: shift.assignees,
  };
  const result = isUpdate
    ? await updatePublishedShift({ ...input, shiftId: shift.connecteamShiftId! })
    : await createPublishedShift(input);

  if (!result.ok) {
    return NextResponse.json({ error: "connecteam_failed", message: result.error ?? "Connecteam rejected the shift." }, { status: 502 });
  }

  updateShift(id, {
    status: "sent",
    // Keep the original id on update; set it on first publish.
    connecteamShiftId: shift.connecteamShiftId ?? result.shiftId ?? `ct-${Date.now()}`,
    connecteamSchedulerId: scheduler.schedulerId,
    connecteamPublishedAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, updated: isUpdate, connecteamShiftId: shift.connecteamShiftId ?? result.shiftId ?? null, notified: shift.assignees.length });
}
