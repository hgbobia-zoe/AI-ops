// AUTO worker-debrief trigger — the unattended job that fires the DUE, UNSENT shift-packet touches for
// every live assignment, so a worker's debrief no longer depends on a human tapping "Send packet". It
// REUSES the gated send path end-to-end (packetSend.dispatchPacketTouch → packet → commsTemplates →
// sendSms) and the same context assembly as the manual endpoint (packetDispatch) — nothing about the
// message, the gates, or the honesty rules is re-implemented here. This file only decides WHICH touch is
// due WHEN, and guarantees a touch is sent AT MOST ONCE, EVER (strict per-(assignment, touch) dedup).
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
import type { StaffShift } from "./types";

/** How far ahead we look for shifts to debrief. Matches the lifecycle tick's window so the two stay in
 *  step. on_assign fires as soon as a shift is committed within this window; day_before / refresher are
 *  time-gated below so they only open at the right lead time. */
const LOOKAHEAD_DAYS = 7;

/** Lead windows for the time-gated touches (deterministic, matched to commsTemplates' documented intent:
 *  day_before ≈ start − 16h, refresher ≈ start − 45m). Because each touch is sent AT MOST ONCE EVER, the
 *  first tick inside a touch's open window sends it; the window only has to be wide enough to never miss. */
export const DAY_BEFORE_OPEN_MS = 18 * 3_600_000; // day_before opens 18h before start
export const DAY_BEFORE_FLOOR_MS = 60 * 60_000; // …and closes 1h before start (too late → let refresher cover)
export const REFRESHER_OPEN_MS = 60 * 60_000; // refresher opens 60m before start
export const REFRESHER_TAIL_MS = 3 * 3_600_000; // …and (when end unknown) stays open until start + 3h

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
 * whether it was already sent (the caller dedups that). Rules:
 *   • nothing is due for a cancelled shift, an uncommitted (not-yet-provisioned) shift, or a shift already
 *     past its end;
 *   • on_assign is due as soon as the shift is committed (the "you're booked" touch);
 *   • day_before is due within [start − 18h, start − 1h] (needs a known window);
 *   • refresher is due from start − 60m until start + 3h / the shift end (needs a known window).
 */
export function dueTouches(i: DueTouchInput, now: number): CommsTouch[] {
  if (i.cancelled || !i.committed) return [];
  if (i.endMs != null && now >= i.endMs) return []; // the shift is over — nothing to send
  const out: CommsTouch[] = ["on_assign"];
  if (i.windowKnown && i.startMs != null) {
    const s = i.startMs;
    if (now >= s - DAY_BEFORE_OPEN_MS && now < s - DAY_BEFORE_FLOOR_MS) out.push("day_before");
    const refresherEnd = i.endMs ?? s + REFRESHER_TAIL_MS;
    if (now >= s - REFRESHER_OPEN_MS && now < refresherEnd) out.push("refresher");
  }
  return out;
}

/** True only when every master switch the auto-trigger depends on is ON. When false the job is a no-op. */
export function autoPacketReady(): boolean {
  return autoPacketEnabled() && shiftCommsEnabled() && smsSendEnabled();
}

/** Has this shift been PROVISIONED (left the building), so an on_assign debrief is warranted? Published to
 *  Connecteam, posted to Instawork, the legacy status is 'sent', or the derived lifecycle has advanced to
 *  PROVISIONED+. A bare draft the human hasn't committed is deliberately NOT debriefed. */
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
  return { ok: failed === 0, detail: parts.join(", ") };
}
