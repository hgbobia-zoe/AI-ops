// AUTO worker-debrief trigger — the unattended job that fires the ONE due, unsent shift debrief for each
// live assignment, so a worker's debrief no longer depends on a human tapping "Send packet". It REUSES the
// gated send path end-to-end (packetSend.dispatchPacketTouch → packet → commsTemplates → sendSms) and the
// same context assembly as the manual endpoint (packetDispatch) — nothing about the message, the gates, or
// the honesty rules is re-implemented here. This file only decides WHO gets debriefed WHEN, and guarantees a
// debrief is sent AT MOST ONCE, EVER (strict per-(assignment, touch) dedup).
//
// OWNER RULES (why this is narrow):
//   • ROUTE CREW ONLY — a driver or field helper assigned to a ROUTE. Warehouse prep / day-level shifts are
//     NOT auto-debriefed (they don't need a route report).
//   • ~2 HOURS BEFORE the shift — a SINGLE debrief (the "Shift soon" touch), never on assignment and never
//     the night before. A shift with no known start time isn't auto-debriefed (can't time it).
//
// SAFETY (these texts go to real workers): the job sends ONLY when ALL of the following hold —
//   • AUTO_PACKET_ENABLED === "true"   its OWN master switch, DEFAULT OFF (autoPacketEnabled)
//   • SHIFT_COMMS_ENABLED === "true"   the existing worker-comms master switch (enforced again in
//                                      dispatchPacketTouch, which previews instead of sending when off)
//   • SMS_SEND_ENABLED    === "true"   the global SMS switch
//   • the Route Staffing Pre-Check is NOT a gap (enforced inside dispatchPacketTouch — an unstaffed
//     route's debrief is HELD, never sent)
// With AUTO_PACKET_ENABLED off (the default) this is a healthy no-op: it builds nothing and sends nothing.
// Instawork temps are debriefed too WHEN their booked-pro phone has been captured (the Auto-Pull extension
// scrapes it from the timesheet view into the contacts store); until then dispatchPacketTouch skips them —
// never auto-texted, never a silent "fail". Honest throughout: a provider/data gap is a skip, not a faked
// send; packet_sent_at is set only on a real send (by dispatchPacketTouch).

import { getDb } from "@/lib/db";
import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import { getShiftsForDate } from "./store";
import { autoPacketEnabled, shiftCommsEnabled, smsSendEnabled } from "./commsFlag";
import { getAssignmentsForShift, hasShiftEvent, logShiftEvent } from "./assignments";
import { isLiveAssignment } from "./lifecycle";
import { dispatchPacketTouch } from "./packetSend";
import { buildSharedPacketContext, assignmentPacketInputs, packetOriginFromEnv } from "./packetDispatch";
import type { CommsTouch } from "./commsTemplates";
import { getUsers, connecteamConfigured, type CrewMember } from "@/lib/connecteam";
import { recordSchedulingAlarm } from "./autoAssignAlarm";
import { slackNotify } from "@/lib/notify/slack";
import type { StaffShift } from "./types";

/** How far ahead we look for shifts to debrief. Matches the lifecycle tick's window so the two stay in
 *  step. The single debrief is time-gated below (dueTouches), so it only fires inside the 2h-before window —
 *  a wider lookahead here just means a shift is in scope earlier; it is not debriefed until it's due. */
const LOOKAHEAD_DAYS = 7;

/** How long before a shift starts the SINGLE debrief goes out. Owner rule: debrief ~2 hours before, never
 *  earlier (no on-assign/night-before blasts). The tick runs every ~15 min, so the first tick inside the 2h
 *  window sends it; sent at most once ever per assignment. */
export const DEBRIEF_LEAD_MS = 2 * 3_600_000; // 2 hours

/** The facts the due-window decision needs — all deterministic, all from the shift + the clock. */
export interface DueTouchInput {
  startMs: number | null; // shift start epoch ms (null = window unknown)
  endMs: number | null; // shift end epoch ms (null = unknown)
  windowKnown: boolean;
  committed: boolean; // the shift has been provisioned (published / posted / lifecycle advanced)
  cancelled: boolean;
}

/**
 * Which touches are DUE for a shift right now (PURE — no DB, no I/O). A touch being "due" is separate from
 * whether it was already sent (the caller dedups that). Owner rule: exactly ONE debrief, ~2 hours before the
 * shift — never on assignment and never the night before. Nothing is due for a cancelled or uncommitted
 * shift, a shift with no known start time (can't time a 2h-before debrief), a shift already started, or one
 * past its end. The single touch is the "Shift soon" (refresher) template — the right tone 2h out, and it
 * carries the delivery-route link.
 */
export function dueTouches(i: DueTouchInput, now: number): CommsTouch[] {
  if (i.cancelled || !i.committed) return [];
  if (!i.windowKnown || i.startMs == null) return []; // no known start → can't send a 2h-before debrief
  if (i.endMs != null && now >= i.endMs) return []; // shift is over
  const s = i.startMs;
  if (now >= s) return []; // shift already started — too late to debrief ahead of it
  return now >= s - DEBRIEF_LEAD_MS ? ["refresher"] : []; // within 2h before start → send; earlier → not yet
}

/** True only when every master switch the auto-trigger depends on is ON. When false the job is a no-op. */
export function autoPacketReady(): boolean {
  return autoPacketEnabled() && shiftCommsEnabled() && smsSendEnabled();
}

/** Has this shift been PROVISIONED (left the building), so a debrief is warranted? Published to Connecteam,
 *  posted to Instawork, the legacy status is 'sent', or the derived lifecycle has advanced to PROVISIONED+.
 *  A bare draft the human hasn't committed is deliberately NOT debriefed. */
function shiftCommitted(s: StaffShift): boolean {
  if (s.connecteamShiftId || s.instaworkPostedAt || s.status === "sent") return true;
  const st = s.lifecycleState;
  return st === "PROVISIONED" || st === "NOTIFIED" || st === "CONFIRMED" || st === "READY" || st === "IN_PROGRESS" || st === "COMPLETE";
}

/** The per-(assignment, touch) idempotency key. A touch is sent at most once EVER per assignment; this key
 *  is recorded only on a real send, and checked before every send, so a re-run never re-texts a worker. */
export function autoPacketChangeKey(assignmentId: string, touch: CommsTouch): string {
  return `${assignmentId}:auto_packet:${touch}`;
}

/** Hard cap on sends per tick — a backstop so a misconfiguration can never fan out unbounded SMS at once. */
const MAX_SENDS_PER_TICK = 200;

export interface WorkerPacketsResult {
  ok: boolean;
  detail: string;
}

/** Distinct dates with built shifts in [today, today+LOOKAHEAD]. */
function windowDates(today: string): string[] {
  const to = shiftYmd(today, LOOKAHEAD_DAYS);
  const rows = getDb()
    .prepare("SELECT DISTINCT date FROM staff_shifts WHERE date BETWEEN ? AND ? ORDER BY date")
    .all(today, to) as { date: string }[];
  return rows.map((r) => r.date);
}

/**
 * Run one auto-packet tick. Never throws (the runtime runner logs failures). Returns a short human detail.
 * No-op (sends nothing, touches no shift) unless every master switch is on.
 */
export async function runWorkerPacketsTick(now: Date = new Date()): Promise<WorkerPacketsResult> {
  // MASTER-SWITCH GATE. Off by default → healthy no-op BEFORE any DB read or context build. Sends nothing.
  if (!autoPacketReady()) {
    const why = !autoPacketEnabled()
      ? "AUTO_PACKET_ENABLED off"
      : !shiftCommsEnabled()
        ? "SHIFT_COMMS_ENABLED off"
        : "SMS_SEND_ENABLED off";
    return { ok: true, detail: `auto-packet idle (${why})` };
  }

  const today = todayInOpsTz();
  const dates = windowDates(today);
  if (dates.length === 0) return { ok: true, detail: "no shifts in window" };

  const users = connecteamConfigured() ? await getUsers().catch(() => new Map<number, CrewMember>()) : new Map<number, CrewMember>();
  const origin = packetOriginFromEnv();
  const actor = "system (auto-packet)";
  const nowMs = now.getTime();

  let sent = 0;
  let skipped = 0;
  let held = 0;
  let failed = 0;
  let capped = false;

  outer: for (const date of dates) {
    for (const shift of getShiftsForDate(date)) {
      if (shift.status === "cancelled") continue;
      // ROUTE CREW ONLY (owner rule): auto-debriefs go to people assigned to a ROUTE — a driver or field
      // helper on a route. Warehouse prep and any non-route (day-level) shift are NOT auto-debriefed.
      if (!shift.routeId || (shift.role !== "driver" && shift.role !== "field")) continue;
      const live = getAssignmentsForShift(shift.id).filter((a) => isLiveAssignment(a.state));
      if (live.length === 0) continue;

      const startMs = shift.startTime ? Date.parse(shift.startTime) : null;
      const endMs = shift.endTime ? Date.parse(shift.endTime) : null;
      const due = dueTouches(
        {
          startMs: startMs != null && Number.isFinite(startMs) ? startMs : null,
          endMs: endMs != null && Number.isFinite(endMs) ? endMs : null,
          windowKnown: shift.windowKnown,
          committed: shiftCommitted(shift),
          cancelled: false,
        },
        nowMs,
      );
      if (due.length === 0) continue;

      const shared = buildSharedPacketContext(shift, users);
      for (const a of live) {
        const { ctx, workerPhone, link } = assignmentPacketInputs(shift, a, live, shared, users, origin, actor);
        for (const touch of due) {
          // STRICT IDEMPOTENCY: never re-send a touch. The key is recorded only on a real send below.
          const changeKey = autoPacketChangeKey(a.id, touch);
          if (hasShiftEvent(changeKey)) continue;

          const dispatch = await dispatchPacketTouch({ shift, assignment: a, ctx, touch, workerPhone, link, actor });
          if (dispatch.state === "sent") {
            // Record the per-touch idempotency + audit row ONLY after the provider reported ok, so a failed
            // or skipped/held touch stays eligible to retry on a later tick (never a silent drop).
            logShiftEvent({ shiftId: shift.id, assignmentId: a.id, actor, kind: "packet_sent", field: "auto_touch", toValue: touch, changeKey });
            sent += 1;
            if (sent >= MAX_SENDS_PER_TICK) {
              capped = true;
              break outer;
            }
          } else if (dispatch.state === "held") {
            held += 1;
          } else if (dispatch.state === "failed") {
            failed += 1;
          } else {
            // "skipped" (Instawork / no phone) or "preview" (switch flipped off mid-tick) — honest no-send.
            skipped += 1;
          }
        }
      }
    }
  }

  const parts = [`${sent} sent`];
  if (held) parts.push(`${held} held (route gap)`);
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (capped) parts.push(`capped at ${MAX_SENDS_PER_TICK}`);

  // FAIL-LOUD: a provider FAILURE means a staffed route's pre-shift debrief silently did not go out (a
  // "held" is a route gap — the pre-check already pages that; a "skipped" is an honest no-phone Instawork
  // temp). Page the ops channel (2h-deduped + one "recovered" note), reusing the shared alarm decider. This
  // only runs when every debrief master switch is on (we returned early otherwise), so a disabled/no-op day
  // never alarms.
  const { alert } = recordSchedulingAlarm("debriefSilent", failed > 0, nowMs);
  if (alert === "down") {
    void slackNotify(
      `Auto debrief: ${failed} shift debrief${failed === 1 ? "" : "s"} for a staffed route failed to send this cycle, so ${failed === 1 ? "that worker" : "those workers"} did not get their pre-shift debrief. Check the SMS provider and /admin/health.`,
    ).catch(() => {});
  } else if (alert === "recovered") {
    void slackNotify("Auto debrief: shift debrief sends are succeeding again. Debrief-failure alarm cleared.").catch(() => {});
  }

  return { ok: failed === 0, detail: parts.join(", ") };
}
