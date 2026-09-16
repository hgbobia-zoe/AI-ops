// Route health — flags routes that need the team's attention: a route still OPEN (not closed) after its
// scheduled delivery date, carrying whatever stops aren't Completed/Returned. RULES CALCULATE: it's a
// plain query over the route/stop states, never a guess. It powers a deduped Slack alert (ops channel,
// run on the server-side timer) and an in-app banner on the Dispatch board. Day-granular: routes carry a
// scheduled DATE, not a time, so "overdue" means the delivery day has passed.

import { getOpenRoutes } from "@/lib/db/repo";
import { getActiveVehicles } from "@/lib/vehicles";
import { todayInOpsTz } from "@/lib/dates";
import { slackNotify, slackConfigured } from "@/lib/notify/slack";
import { getRouteHealthAlerted, setRouteHealthAlerted } from "@/lib/pull/state";
import type { StopState } from "@/lib/types";

const DONE: StopState[] = ["Completed", "Returned"]; // a stop is finished only in these states
const REALERT_HOURS = 12; // still-unresolved routes re-alert at most this often

export interface RouteHealthIssue {
  routeId: string;
  truckId: string;
  truckLabel: string;
  date: string; // scheduled delivery day (YYYY-MM-DD)
  driverName: string | null;
  daysOverdue: number;
  totalStops: number;
  incompleteStops: { sequence: number; custName: string; state: StopState; kind: string }[];
}

function ymdDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : 0;
}

/** Open routes whose scheduled delivery date has already passed (still not closed). Each carries the
 *  stops that aren't Completed/Returned, so the team sees exactly what's outstanding. Today's and future
 *  routes are excluded — a route in progress on its own day isn't overdue. */
export function findRouteHealthIssues(nowYmd: string = todayInOpsTz()): RouteHealthIssue[] {
  const trucks = getActiveVehicles();
  const label = (id: string): string => trucks.find((t) => t.truckId === id)?.name ?? id;
  const out: RouteHealthIssue[] = [];
  for (const r of getOpenRoutes()) {
    if (r.date >= nowYmd) continue; // only past-date open routes are overdue (lexical YMD compare)
    const incomplete = r.stops.filter((s) => !DONE.includes(s.state));
    out.push({
      routeId: r.routeId,
      truckId: r.truckId,
      truckLabel: label(r.truckId),
      date: r.date,
      driverName: r.driverName ?? null,
      daysOverdue: ymdDaysBetween(r.date, nowYmd),
      totalStops: r.stops.length,
      incompleteStops: incomplete.map((s) => ({ sequence: s.sequence, custName: s.custName, state: s.state, kind: s.kind ?? "delivery" })),
    });
  }
  return out;
}

function buildMessage(issues: RouteHealthIssue[]): string {
  const lines: string[] = [`:truck: *${issues.length} route${issues.length === 1 ? "" : "s"} still open past the delivery date* — needs action:`];
  for (const i of issues.slice(0, 12)) {
    const driver = i.driverName ? ` · ${i.driverName}` : "";
    const n = i.incompleteStops.length;
    const head = `• *${i.truckLabel}* — ${i.date} (${i.daysOverdue}d overdue)${driver}: ${n === 0 ? "route not closed" : `${n}/${i.totalStops} stop${n === 1 ? "" : "s"} not completed`}`;
    const names = i.incompleteStops
      .slice(0, 5)
      .map((s) => `${s.custName || `stop ${s.sequence}`}${s.state !== "Waiting" ? ` (${s.state})` : ""}`)
      .join(", ");
    lines.push(names ? `${head} — ${names}` : head);
  }
  if (issues.length > 12) lines.push(`…and ${issues.length - 12} more.`);
  lines.push("_Close the route in Dispatch once done, or reschedule the open stops._");
  return lines.join("\n");
}

/** Scan for overdue open routes and post ONE deduped Slack alert to the ops channel. Each route is
 *  alerted once, re-alerted only after REALERT_HOURS while it stays unresolved; a route that's since been
 *  closed/finished drops out of the dedup map so a later recurrence alerts again. Best-effort: a silent
 *  no-op when Slack isn't configured. */
export async function runRouteHealthCheck(now: Date = new Date()): Promise<{ flagged: number; alerted: number }> {
  const issues = findRouteHealthIssues();
  const seen = getRouteHealthAlerted();

  if (issues.length === 0) {
    if (Object.keys(seen).length) setRouteHealthAlerted({}); // all resolved — reset the dedup map
    return { flagged: 0, alerted: 0 };
  }

  const cutoff = now.getTime() - REALERT_HOURS * 3_600_000;
  const due = issues.filter((i) => {
    const last = seen[i.routeId];
    return !last || Date.parse(last) < cutoff;
  });

  let alerted = 0;
  if (due.length > 0 && slackConfigured()) {
    const res = await slackNotify(buildMessage(due));
    if (res.ok) {
      alerted = due.length;
      const iso = now.toISOString();
      const active = new Set(issues.map((i) => i.routeId));
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(seen)) if (active.has(k)) next[k] = v; // carry still-open routes
      for (const i of due) next[i.routeId] = iso; // freshen the ones we just alerted
      setRouteHealthAlerted(next);
    }
  } else {
    // Nothing due to alert — just prune routes that are no longer flagged from the dedup map.
    const active = new Set(issues.map((i) => i.routeId));
    const pruned = Object.fromEntries(Object.entries(seen).filter(([k]) => active.has(k)));
    if (Object.keys(pruned).length !== Object.keys(seen).length) setRouteHealthAlerted(pruned);
  }

  return { flagged: issues.length, alerted };
}
