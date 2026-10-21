// The shift-packet SEND path, MASTER-SWITCHED OFF by default (SHIFT_COMMS_ENABLED, via commsFlag.ts),
// mirroring SMS_SEND_ENABLED / EMAIL_SEND_ENABLED. Until the switch is on, this is PREVIEW / RECORD-ONLY:
// the packet is built + persisted (so "what would this worker receive" is answerable) but NOTHING is sent
// and packet_sent_at is NEVER set. When the switch is on, a worker with a known phone is texted through the
// existing provider; a comms step is marked "sent" ONLY when the provider actually reports ok (never
// assumed). A worker with no phone on file is honestly "skipped" — internal: no number; Instawork: the
// booked-pro phone hasn't been captured yet (the Auto-Pull extension scrapes it from the timesheet view).

import { shiftCommsEnabled } from "./commsFlag";
import { buildShiftPacket, saveShiftPacket, type PacketContext } from "./packet";
import { renderPacketTouch, type CommsTouch } from "./commsTemplates";
import { updateAssignment, logShiftEvent } from "./assignments";
import { resolveAssignmentTransition } from "./lifecycle";
import { preCheckGateForShift } from "./preCheck";
import { notifyRouteGapIfDue } from "./preCheckNotify";
import { sendSms } from "@/lib/notify/sms";
import type { ShiftAssignment, StaffShift } from "./types";

/** Honest comms reliability states we can actually assert today. "delivered"/"confirmed" are NOT here:
 *  there is no outbound delivery webhook wired, so we never claim beyond "sent" (what the API reports).
 *  "held" = the Route Staffing Pre-Check found this route under-assigned, so its debrief was withheld. */
export type PacketSendState = "preview" | "skipped" | "sent" | "failed" | "held";

export interface TouchDispatch {
  touch: CommsTouch;
  version: string;
  body: string;
  state: PacketSendState;
  gated: boolean; // true = send switch is off, so this is preview/record-only
  reason?: string;
}

export interface DispatchArgs {
  shift: StaffShift;
  assignment: ShiftAssignment;
  ctx: PacketContext;
  touch: CommsTouch;
  workerPhone?: string | null;
  link?: string | null;
  /** The AI customer-attention heads-up for this route, computed UPSTREAM (async) once per route and passed
   *  in as a precomputed string (same contract as `link`). null/undefined → the {customerAttention} line
   *  drops. Never computed here, so this send path stays sync and the LLM can never block a debrief. */
  customerAttention?: string | null;
  actor?: string;
}

/** Build + persist the packet, render the touch, then preview (gated) or send (switch on). */
export async function dispatchPacketTouch(args: DispatchArgs): Promise<TouchDispatch> {
  const { shift, assignment, ctx, touch, workerPhone, link = null, customerAttention = null, actor = "system" } = args;
  const packet = buildShiftPacket(shift, assignment, ctx);
  const version = saveShiftPacket(packet);
  const body = renderPacketTouch(packet, touch, link, customerAttention);

  // Master switch OFF -> preview/record-only. The packet exists; nothing is sent; packet_sent_at stays null.
  if (!shiftCommsEnabled()) {
    return { touch, version, body, state: "preview", gated: true };
  }

  // ROUTE STAFFING PRE-CHECK GATE. Before sending a route's debrief/pre-brief, verify the route has its
  // required crew ASSIGNED in the app (doc §2.2 — Connecteam schedule is not coverage). If the route has a
  // gap, HOLD the send and ensure the notification fires (fire-and-forget; dedup prevents spam). The hold
  // clears ONLY when crew is actually assigned (status flips to "ok") — there is no manual override, so a
  // debrief can never go out to an unstaffed route. Pure/local decision — no Connecteam call in the hot
  // path. Idempotent: a re-run holds again without sending, and the alert is deduped in recordPreCheckAlert.
  const gate = preCheckGateForShift(shift);
  if (gate && gate.status === "gap") {
    if (shift.routeId) void notifyRouteGapIfDue(shift.date, shift.routeId).catch(() => {});
    return { touch, version, body, state: "held", gated: false, reason: `Route staffing gap: ${gate.reason}. Assign crew to close it.` };
  }

  // Switch ON. Send when we have a phone — internal (Connecteam) OR Instawork (the captured booked-pro phone
  // the Auto-Pull extension scrapes from the timesheet view). No phone on file → honest skip with a
  // kind-specific reason, never a faked send.
  if (!workerPhone) {
    const reason =
      assignment.workerKind === "instawork"
        ? "Instawork worker contact not captured; informed through Instawork."
        : "No phone on file for this worker.";
    return { touch, version, body, state: "skipped", gated: false, reason };
  }

  const res = await sendSms(workerPhone, body);
  if (!res.ok) {
    return { touch, version, body, state: "failed", gated: false, reason: res.error ?? "send failed" };
  }
  // Sent for real -> record it. Only now is packet_sent_at set (readiness can count it), and the
  // assignment advances ASSIGNED -> NOTIFIED if the transition is legal (never forced past a guard).
  const now = new Date().toISOString();
  const nextState = resolveAssignmentTransition(assignment.state, "NOTIFY");
  updateAssignment(assignment.id, { packetSentAt: now, packetVersion: version, ...(nextState ? { state: nextState } : {}) });
  logShiftEvent({ shiftId: shift.id, assignmentId: assignment.id, actor, kind: "packet_sent", field: "packet_version", toValue: version, changeKey: `${assignment.id}:packet_sent:${version}` });
  return { touch, version, body, state: "sent", gated: false };
}
