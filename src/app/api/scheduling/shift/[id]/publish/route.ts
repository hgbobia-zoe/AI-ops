// Publish a built shift to Connecteam — the "send it to the crew" step. Creates a PUBLISHED Connecteam
// shift (notifies the assigned crew) for the internal assignees. Human-gated: owner/admin only, the shift
// must already be CONFIRMED, have a real time window, and have at least one internal assignee. Idempotent:
// a shift already carrying a connecteamShiftId is never published twice. The Instawork gap is a separate
// (later) step — this sends only the internal half.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getShiftById, updateShift } from "@/lib/scheduling/store";
import { createPublishedShift, updatePublishedShift, getCrewForDateSafe, getDefaultScheduler, getSchedulers, getUsers, connecteamShiftNotesEnabled } from "@/lib/connecteam";
import { matchConnecteamShiftForPush, unionPushWindowUnix } from "@/lib/scheduling/connecteamImport";
import { insertAudit } from "@/lib/db/repo";
import { assembleShiftDebriefContext } from "@/lib/scheduling/packetDispatch";
import { buildShiftDebriefNote } from "@/lib/scheduling/shiftDebrief";
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

  // DE-DUP THE PUSH. Idempotency was keyed ONLY on this app shift's own connecteam_shift_id, so publishing a
  // shift the app had not itself linked created a SECOND Connecteam shift even when the worker already had one
  // that day (one Lisa built directly in Connecteam, or one from another route) — the reported duplicate.
  // Before creating, match the worker's EXISTING Connecteam shift and UPDATE it in place instead, unioning the
  // window so a longer human shift is never truncated. Honest: only when the day's Connecteam read succeeds
  // (we won't match blind on an outage — then we fall back to the previous create, unchanged).
  let targetShiftId = shift.connecteamShiftId;
  let targetSchedulerId = shift.connecteamSchedulerId;
  let pushStartIso: string = shift.startTime;
  let pushEndIso: string = shift.endTime;
  let pushAssignees = shift.assignees;
  if (!targetShiftId) {
    const crew = await getCrewForDateSafe(shift.date);
    if (crew.ok) {
      const m = matchConnecteamShiftForPush(shift, crew.shifts);
      if (m) {
        const win = unionPushWindowUnix(shift.startTime, shift.endTime, m);
        targetShiftId = String(m.id);
        targetSchedulerId = m.schedulerId;
        pushStartIso = new Date(win.startUnix * 1000).toISOString();
        pushEndIso = new Date(win.endUnix * 1000).toISOString();
        pushAssignees = [...new Set([...m.assignees.map((a) => a.userId), ...shift.assignees])].sort((a, b) => a - b);
      }
    }
  }
  const isUpdate = Boolean(targetShiftId);

  // On an update, stay on the scheduler the shift was first published to (or the matched shift's); else default.
  const scheduler = isUpdate && targetSchedulerId
    ? (await getSchedulers()).find((s) => s.schedulerId === targetSchedulerId) ?? (await getDefaultScheduler())
    : await getDefaultScheduler();
  if (!scheduler) {
    return fail(400, "NO_SCHEDULER", { error: "no_scheduler", message: "No Connecteam scheduler is reachable." });
  }

  const startUnix = Math.floor(Date.parse(pushStartIso) / 1000);
  const endUnix = Math.floor(Date.parse(pushEndIso) / 1000);
  if (!startUnix || !endUnix || endUnix <= startUnix) {
    return fail(400, "BAD_TIME", { error: "bad_time", message: "The shift's time window is invalid." });
  }

  // Route debrief → Connecteam shift note (Improvement 1). Assembled from the same structured route facts as
  // the SMS packet (no LLM). Only attached when note writes are enabled (the field is unverified against the
  // live API, so it is opt-in and can never break a publish by default). Build failures never block the send.
  let note: string | undefined;
  if (connecteamShiftNotesEnabled()) {
    try {
      const ctx = assembleShiftDebriefContext(shift, await getUsers());
      if (ctx) note = buildShiftDebriefNote(ctx);
    } catch (e) {
      console.error("[publish] debrief note build failed (ignored):", String(e));
    }
  }

  const input = {
    schedulerId: scheduler.schedulerId,
    title: `${ROLE_LABEL[shift.role]} — ${shift.eventLabel || shift.date}`,
    startUnix,
    endUnix,
    timezone: scheduler.timezone,
    assignedUserIds: pushAssignees,
    note,
  };
  const result = isUpdate
    ? await updatePublishedShift({ ...input, shiftId: targetShiftId! })
    : await createPublishedShift(input);

  if (!result.ok) {
    return fail(502, "CONNECTEAM_FAILED", { error: "connecteam_failed", message: result.error ?? "Connecteam rejected the shift.", schedulerId: scheduler.schedulerId });
  }

  const connecteamShiftId = targetShiftId ?? result.shiftId ?? `ct-${Date.now()}`;
  updateShift(id, {
    status: "sent",
    // Keep the original/matched id on update; set it on first publish.
    connecteamShiftId,
    connecteamSchedulerId: scheduler.schedulerId,
    connecteamPublishedAt: new Date().toISOString(),
    // Persist the (possibly unioned) window + assignees we actually pushed, and re-baseline so the importer
    // adopts this link instead of re-flagging it as a conflict.
    startTime: pushStartIso,
    endTime: pushEndIso,
    windowKnown: true,
    assignees: pushAssignees,
    connecteamContentHash: null,
    connecteamSyncedAt: new Date().toISOString(),
    syncStatus: "synced",
    syncNote: null,
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

  return NextResponse.json({ ok: true, updated: isUpdate, connecteamShiftId: targetShiftId ?? result.shiftId ?? null, notified: pushAssignees.length });
}
