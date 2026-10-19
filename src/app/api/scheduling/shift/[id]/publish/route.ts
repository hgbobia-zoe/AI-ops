// Publish a built shift to Connecteam — the "send it to the crew" step. Creates a PUBLISHED Connecteam
// shift (notifies the assigned crew) for the internal assignees. Human-gated: owner/admin only, the shift
// must already be CONFIRMED, have a real time window, and have at least one internal assignee. Idempotent:
// a shift already carrying a connecteamShiftId is never published twice. The Instawork gap is a separate
// (later) step — this sends only the internal half.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getShiftById, updateShift } from "@/lib/scheduling/store";
import { createPublishedShift, updatePublishedShift, getDefaultScheduler, getSchedulers } from "@/lib/connecteam";
import { insertAudit } from "@/lib/db/repo";
import type { ShiftRole } from "@/lib/scheduling/types";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<ShiftRole, string> = { driver: "Driver", field: "Field", prep: "Prep", office: "Office" };

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const actor = (await currentActor()).label;
  const { id } = await params;
  // Audit EVERY outcome (success and each failure reason) — this flow had no trail, so a silent publish
  // failure was invisible. `action` tells apart a real send from a gate/Connecteam rejection at a glance.
  const fail = (status: number, action: string, body: Record<string, unknown>): NextResponse => {
    try {
      insertAudit({ actor, action: `SHIFT_PUBLISH_${action}`, entity: "staff_shift", entityId: id, after: body });
    } catch {
      /* audit must never block the response */
    }
    return NextResponse.json(body, { status });
  };

  if (!canManageSettings(await viewerRole())) {
    return fail(403, "FORBIDDEN", { error: "forbidden" });
  }
  const shift = getShiftById(id);
  if (!shift) return fail(404, "NOT_FOUND", { error: "not_found" });

  const isUpdate = Boolean(shift.connecteamShiftId);

  // Human-approval + data gates (apply to both first publish and re-publish of an edited shift).
  if (shift.status !== "confirmed") {
    return fail(409, "CONFIRM_FIRST", { error: "confirm_first", message: "Confirm the shift before sending it to the crew." });
  }
  if (!shift.windowKnown || !shift.startTime || !shift.endTime) {
    return fail(400, "NO_WINDOW", { error: "no_window", message: "Set a start and end time first." });
  }
  if (shift.assignees.length === 0) {
    return fail(400, "NO_ASSIGNEES", { error: "no_assignees", message: "Assign internal crew before publishing (the Instawork gap is sent separately)." });
  }

  // On an update, stay on the scheduler the shift was first published to; else pick the default.
  const scheduler = isUpdate && shift.connecteamSchedulerId
    ? (await getSchedulers()).find((s) => s.schedulerId === shift.connecteamSchedulerId) ?? (await getDefaultScheduler())
    : await getDefaultScheduler();
  if (!scheduler) {
    return fail(400, "NO_SCHEDULER", { error: "no_scheduler", message: "No Connecteam scheduler is reachable." });
  }

  const startUnix = Math.floor(Date.parse(shift.startTime) / 1000);
  const endUnix = Math.floor(Date.parse(shift.endTime) / 1000);
  if (!startUnix || !endUnix || endUnix <= startUnix) {
    return fail(400, "BAD_TIME", { error: "bad_time", message: "The shift's time window is invalid." });
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
    return fail(502, "CONNECTEAM_FAILED", { error: "connecteam_failed", message: result.error ?? "Connecteam rejected the shift.", schedulerId: scheduler.schedulerId });
  }

  const connecteamShiftId = shift.connecteamShiftId ?? result.shiftId ?? `ct-${Date.now()}`;
  updateShift(id, {
    status: "sent",
    // Keep the original id on update; set it on first publish.
    connecteamShiftId,
    connecteamSchedulerId: scheduler.schedulerId,
    connecteamPublishedAt: new Date().toISOString(),
  });

  try {
    insertAudit({
      actor,
      action: isUpdate ? "SHIFT_PUBLISH_UPDATED" : "SHIFT_PUBLISH_SENT",
      entity: "staff_shift",
      entityId: id,
      after: { connecteamShiftId: result.shiftId ?? connecteamShiftId, schedulerId: scheduler.schedulerId, notified: shift.assignees.length },
    });
  } catch {
    /* audit must never block the response */
  }

  return NextResponse.json({ ok: true, updated: isUpdate, connecteamShiftId: shift.connecteamShiftId ?? result.shiftId ?? null, notified: shift.assignees.length });
}
