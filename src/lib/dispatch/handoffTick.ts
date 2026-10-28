// Route-handoff reconciliation tick — the effects side of dispatch/handoff.ts, run from the runtime clock.
//
// For every truck with routes TODAY it runs the pure planner, then applies the plan idempotently:
//   • Scenario A (verified complete, driver forgot to close) → auto-finalize the route (status done +
//     auto_finalized_at), so the truck is cleanly released. Attributable to the system in the audit log.
//   • Scenario B (route still open, completion unverifiable) → leave the route OPEN, flag it for office
//     reconciliation (status + timestamps preserved), and, on a genuine conflict (truck physically still
//     out), alert dispatch ONCE.
//
// The VISIBILITY fix lives in getActiveRouteForTruck and is independent of this tick — the next driver can
// reach their route whether or not this has run. This tick only cleans up / flags the stale earlier route.
//
// Safety: idempotent (finalize is a no-op once done; flag is a no-op once set; the conflict alert is deduped
// via the audit log), never fabricates a completion, never deletes stops, and a failure on one truck never
// aborts the sweep (each truck is isolated). Recovers after downtime because it re-derives everything from
// current route state on each run.

import {
  getRoutesForDate,
  getTruckIdsWithRoutesOnDate,
  autoFinalizeRoute,
  flagRouteForHandoff,
  insertAudit,
  auditExistsSince,
} from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import { slackNotify } from "@/lib/notify/slack";
import { getHandoffConfig } from "./handoffConfig";
import { planTruckHandoff, type HandoffAction } from "./handoff";

const ENTITY = "route";
const ACTION_FINALIZE = "ROUTE_AUTO_FINALIZED";
const ACTION_FLAG = "ROUTE_HANDOFF_FLAGGED";
const ACTION_CONFLICT = "ROUTE_HANDOFF_CONFLICT_ALERT";

export interface HandoffTickResult {
  ok: boolean;
  detail: string;
  finalized: number;
  flagged: number;
  conflicts: number;
}

/** Apply one truck's plan. Isolated so a throw on one truck cannot abort the whole sweep. */
function applyTruck(
  actions: HandoffAction[],
  notifyOnConflict: boolean,
  nowIso: string,
): { finalized: number; flagged: number; conflicts: number; alerts: string[] } {
  let finalized = 0;
  let flagged = 0;
  let conflicts = 0;
  const alerts: string[] = [];

  for (const a of actions) {
    try {
      if (a.kind === "finalize") {
        const r = autoFinalizeRoute(a.routeId);
        if (r.ok && !r.already) {
          finalized++;
          insertAudit({
            actor: "system",
            action: ACTION_FINALIZE,
            entity: ENTITY,
            entityId: a.routeId,
            after: { truckId: a.truckId, reason: a.reason, at: nowIso },
          });
        }
      } else {
        const r = flagRouteForHandoff(a.routeId, a.reason);
        if (r.ok && !r.already) {
          flagged++;
          insertAudit({
            actor: "system",
            action: ACTION_FLAG,
            entity: ENTITY,
            entityId: a.routeId,
            after: { truckId: a.truckId, reason: a.reason, incompleteStops: a.incomplete, conflict: a.conflict, at: nowIso },
          });
        }
        // Alert dispatch ONCE per genuine conflict (deduped via the audit log, so a repeated tick is quiet).
        if (a.conflict && notifyOnConflict) {
          const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
          if (!auditExistsSince(ENTITY, a.routeId, ACTION_CONFLICT, "system", since)) {
            conflicts++;
            insertAudit({ actor: "system", action: ACTION_CONFLICT, entity: ENTITY, entityId: a.routeId, after: { truckId: a.truckId, at: nowIso } });
            alerts.push(
              `Truck ${a.truckId}: route ${a.routeId} is still open with ${a.incomplete} unfinished stop(s) while its truck is needed for the next route. Next driver can see their route, but this one needs closing or reconciliation.`,
            );
          }
        }
      }
    } catch (e) {
      console.error("[handoffTick] action failed (ignored):", a.routeId, String(e));
    }
  }
  return { finalized, flagged, conflicts, alerts };
}

/**
 * Sweep today's trucks and reconcile stale earlier routes. Pure config-gated; never throws. `now` is
 * injectable for tests.
 */
export async function runRouteHandoffTick(now: Date = new Date()): Promise<HandoffTickResult> {
  const cfg = getHandoffConfig();
  if (!cfg.enabled) return { ok: true, detail: "handoff automation disabled", finalized: 0, flagged: 0, conflicts: 0 };

  const today = todayInOpsTz(now);
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const truckIds = getTruckIdsWithRoutesOnDate(today);

  let finalized = 0;
  let flagged = 0;
  let conflicts = 0;
  const alerts: string[] = [];

  for (const truckId of truckIds) {
    try {
      const routes = getRoutesForDate(truckId, today);
      if (routes.length < 2) continue; // handoff only matters when a truck runs more than one route a day
      const plan = planTruckHandoff(routes, nowMs, cfg.bufferMinutes);
      if (plan.actions.length === 0) continue;
      const res = applyTruck(plan.actions, cfg.notifyOnConflict, nowIso);
      finalized += res.finalized;
      flagged += res.flagged;
      conflicts += res.conflicts;
      alerts.push(...res.alerts);
    } catch (e) {
      console.error("[handoffTick] truck sweep failed (ignored):", truckId, String(e));
    }
  }

  // Fire conflict alerts after the sweep so a Slack hiccup never blocks the DB writes above.
  for (const msg of alerts) {
    try {
      await slackNotify(msg);
    } catch (e) {
      console.error("[handoffTick] slackNotify failed (ignored):", String(e));
    }
  }

  const detail =
    finalized + flagged + conflicts === 0
      ? "no handoffs due"
      : `finalized ${finalized}, flagged ${flagged}, alerted ${conflicts}`;
  return { ok: true, detail, finalized, flagged, conflicts };
}
