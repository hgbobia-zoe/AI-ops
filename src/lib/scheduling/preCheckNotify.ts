// Route Staffing Pre-Check — the Slack notification + its dedupe. When a PRESENT route has a staffing gap,
// we Slack the delivery/ops channel (slackNotify) with: the route (truck + date + stop/customer count),
// what's missing, the Connecteam people who could be assigned, and a link to the scheduling board to act.
//
// DEDUPE (recordPreCheckAlert): one alert per route per gap with a 2h cool-off, re-alert if the gap persists
// past the cool-off or WORSENS, and one "recovered" note when it clears. GATED so it never nags when there's
// nothing to staff — runPreCheckAlerts only touches days that actually have present routes (the pre-check
// returns [] for an empty day), mirroring the ignition alert's hasDeliveriesToday gate.
//
// Best-effort + isolated: a Slack failure never throws into the send path or the runtime tick.

import { slackNotify } from "@/lib/notify/slack";
import { routePreChecksForDate, type RoutePreCheck } from "./preCheck";
import { recordPreCheckAlert, recordScheduledUnroutedNudge } from "./preCheckStore";
import { scheduledUnroutedForDate } from "./scheduledUnrouted";

/** The board link for a day. This runs request-less (send-path / runtime tick), so it uses the explicit
 *  PUBLIC_BASE_URL (the same env publicOrigin prefers); without it, a relative path (still clickable in-app). */
function boardLink(date: string): string {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const path = `/scheduling?date=${date}`;
  return base ? `${base}${path}` : path;
}

/** The Slack body for one gapped route. Facts only; no dashes in the prose (house style). */
export function formatRouteGapAlert(pc: RoutePreCheck): string {
  const where = `${pc.truckName} on ${pc.date}`;
  const size = `${pc.stopCount} stop${pc.stopCount === 1 ? "" : "s"}, ${pc.customerCount} customer${pc.customerCount === 1 ? "" : "s"}`;
  let cands: string;
  if (!pc.connecteamReachable) {
    cands = "Connecteam unreachable, candidate list unknown.";
  } else if (pc.connecteamCandidates.length === 0) {
    cands = "No scheduled Connecteam crew free to assign.";
  } else {
    const names = pc.connecteamCandidates.slice(0, 6).map((c) => `${c.name} (${c.role})`).join(", ");
    cands = `Could assign: ${names}.`;
  }
  return [
    `Route staffing pre-check: ${where} has a gap and its debrief is on hold.`,
    `${pc.reason}. Route is ${size}.`,
    cands,
    `Assign crew to close it: ${boardLink(pc.date)}`,
  ].join("\n");
}

/** The "recovered" note once a previously-alerted route clears — i.e. crew was actually assigned. */
function formatRecovered(truckName: string, date: string): string {
  return `Route staffing pre-check: ${truckName} on ${date} is staffed now. Hold cleared.`;
}

/** Evaluate ONE route and Slack if the dedupe says so. Used by the send-path gate (fire-and-forget) so a
 *  held debrief guarantees the alert fires. Idempotent: the dedupe suppresses repeats within the cool-off. */
export async function notifyRouteGapIfDue(date: string, routeId: string): Promise<void> {
  try {
    const checks = await routePreChecksForDate(date);
    const pc = checks.find((c) => c.routeId === routeId);
    if (!pc) return;
    await emitForRoute(pc);
  } catch (e) {
    console.error("[precheck] notifyRouteGapIfDue failed (isolated):", e);
  }
}

/** Decide + send (or recover) for one already-computed pre-check. A gap clears only when crew is actually
 *  assigned (status flips to "ok"), which fires the recovery note if we had alerted. */
async function emitForRoute(pc: RoutePreCheck): Promise<void> {
  const gapped = pc.status === "gap";
  const { alert } = recordPreCheckAlert(pc.date, pc.routeId, gapped, pc.totalGap);
  if (alert === "gap") await slackNotify(formatRouteGapAlert(pc)).catch(() => {});
  else if (alert === "recovered") await slackNotify(formatRecovered(pc.truckName, pc.date)).catch(() => {});
}

/** The schedule → route NUDGE body: crew scheduled in Connecteam who aren't on a route yet. Additive to the
 *  gap alert — this points the staffer at the one-click assign (it never implies the schedule is coverage). */
export function formatScheduledUnroutedNudge(date: string, count: number): string {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const path = `/scheduling?date=${date}`;
  const link = base ? `${base}${path}` : path;
  const who = `${count} ${count === 1 ? "person" : "people"}`;
  return [
    `Schedule to route: ${who} scheduled in Connecteam on ${date} ${count === 1 ? "is" : "are"} not yet on a route.`,
    `A Connecteam schedule is not route coverage. Assign them to a route in Scheduling: ${link}`,
  ].join("\n");
}

/** Evaluate the schedule → route nudge for a day and Slack if the dedupe says so. Honesty-gated: only when
 *  Connecteam actually answered (reachable), never on an outage. Deduped day-level with the same cool-off. */
export async function runScheduledUnroutedNudge(date: string): Promise<{ scheduledUnrouted: number; nudged: number }> {
  try {
    const res = await scheduledUnroutedForDate(date);
    if (!res.reachable) return { scheduledUnrouted: 0, nudged: 0 };
    const count = res.people.length;
    const { nudge } = recordScheduledUnroutedNudge(date, count);
    if (nudge) await slackNotify(formatScheduledUnroutedNudge(date, count)).catch(() => {});
    return { scheduledUnrouted: count, nudged: nudge ? 1 : 0 };
  } catch (e) {
    console.error("[precheck] runScheduledUnroutedNudge failed (isolated):", e);
    return { scheduledUnrouted: 0, nudged: 0 };
  }
}

export interface PreCheckAlertRun {
  routesChecked: number;
  gaps: number;
  alerted: number;
  recovered: number;
  /** Schedule → route bridge (additive): crew scheduled in Connecteam but not on a route, and nudges sent. */
  scheduledUnrouted: number;
  nudged: number;
}

/** Scan a day's present routes and fire due alerts/recoveries. The runtime tick calls this for a lead-time
 *  window (today + near days). Returns [] work when the day has no present routes (never nags an empty day). */
export async function runPreCheckAlerts(date: string): Promise<PreCheckAlertRun> {
  const checks = await routePreChecksForDate(date);
  let alerted = 0;
  let recovered = 0;
  let gaps = 0;
  for (const pc of checks) {
    if (pc.status === "gap") gaps += 1;
    const gapped = pc.status === "gap";
    const { alert } = recordPreCheckAlert(pc.date, pc.routeId, gapped, pc.totalGap);
    if (alert === "gap") {
      alerted += 1;
      await slackNotify(formatRouteGapAlert(pc)).catch(() => {});
    } else if (alert === "recovered") {
      recovered += 1;
      await slackNotify(formatRecovered(pc.truckName, pc.date)).catch(() => {});
    }
  }
  // Additive schedule → route nudge (own dedupe; does not affect the gap-alert bookkeeping above).
  const su = await runScheduledUnroutedNudge(date);
  return { routesChecked: checks.length, gaps, alerted, recovered, scheduledUnrouted: su.scheduledUnrouted, nudged: su.nudged };
}
