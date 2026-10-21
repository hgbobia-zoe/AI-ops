// Scheduling fail-loud alarms. The driver auto-assign / debrief loop used to fail SILENTLY: a day with
// routes that needed a driver could end with nobody assigned, and the morning debrief could send nothing,
// with no page to anyone. These alarms close that gap. They REUSE the shared job-alert decider
// (decideJobAlert — the same 2h cool-off + one-shot "recovered" note the responder/instawork/precheck
// alarms use) over a per-alarm kv row, so there is no new notification system and no new slack infra.
//
// PURE at the core (decideJobAlert); this module is the thin kv glue. The CALLER composes the message (it
// has the live counts) and does the slackNotify, mirroring recordJobAlert in responderHealth.ts.

import { getJson, setJson } from "@/lib/kv";
import { decideJobAlert, type JobAlertRecord, RESPONDER_JOB_COOLOFF_MS } from "@/lib/ai/responderHealth";

/** One kv row per alarm (settings table, no migration — mirrors ai.responder.alert). */
const KEYS = {
  /** A reachable sync day ended with present route(s) needing a driver and none assigned (route row empty
   *  AND no driver staff_shift) — auto-assign produced nothing for a route that needs crew. */
  driverlessRoutes: "scheduling.alarm.driverlessRoutes",
  /** The auto-debrief tick failed to send a debrief for a staffed route (provider failure) — a worker's
   *  pre-shift debrief silently did not go out. */
  debriefSilent: "scheduling.alarm.debriefSilent",
  /** One or more SCHEDULED workers have no Connecteam Title set, so their crew role can't be determined.
   *  They are never auto-assigned (roleFromTitle -> "other" -> not auto-route-eligible), but a human must
   *  set the Title so the gap is fixed, not silently dropped. */
  untitledWorkers: "scheduling.alarm.untitledWorkers",
} as const;

export type SchedulingAlarmKind = keyof typeof KEYS;

/**
 * Decide + persist one scheduling alarm's state, reusing decideJobAlert. `down` = the bad condition holds
 * right now. Returns "down" to page (never-alerted or the cool-off elapsed), "recovered" once when it
 * clears (only if we had paged), else null. The caller does the Slack post with its own live detail.
 * Honest: callers MUST NOT call this on an UNKNOWN day (e.g. an integration outage) — only when the
 * condition is actually known — so a recovery is never falsely emitted during an outage.
 */
export function recordSchedulingAlarm(
  kind: SchedulingAlarmKind,
  down: boolean,
  now: number = Date.now(),
  cooloffMs: number = RESPONDER_JOB_COOLOFF_MS,
): { alert: "down" | "recovered" | null } {
  const key = KEYS[kind];
  const stored = getJson<JobAlertRecord>(key, {});
  const prev = stored.firstDownAt || stored.lastAlertedAt ? stored : undefined;
  const { alert, next } = decideJobAlert(prev, down, now, cooloffMs);
  setJson(key, next ?? {});
  return { alert };
}
