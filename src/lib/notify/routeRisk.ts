// Proactive route-risk alerts → Slack. Runs when a route is imported/pulled, so dispatch
// hears about a problem the moment the route lands — not when someone happens to open the
// board. Currently:
//   1. business/office stops scheduled outside open hours (a truck showing up while the place is closed);
//   2. sequencing: a stop whose planned arrival lands well past its customer window, usually because a
//      long stop is stacked before it (Oct 31 2026: Montealegre 1h 55m planned on site, then McGahn with
//      the same 9:00 window). Upcoming routes only; history is not re-alerted.
// Throttled per route+risk-set so auto-pull can't spam.

import type { Route } from "@/lib/types";
import { reviewStopAddress } from "@/lib/addressReview";
import { todayInOpsTz } from "@/lib/dates";
import { routePlanStops, stackingWarnings, type StackWarning } from "@/lib/dispatch/onTime";
import { slackNotify } from "./slack";

const g = globalThis as unknown as { __routeRiskSeen?: Map<string, string>; __routeStackSeen?: Map<string, string> };
const seen = (g.__routeRiskSeen ??= new Map<string, string>());
const stackSeen = (g.__routeStackSeen ??= new Map<string, string>());

/** The Slack body for a route's sequencing warnings. Plain sentences, no dashes or emoji (house style). */
export function formatStackAlert(truck: string, date: string, warnings: StackWarning[]): string {
  const n = warnings.length;
  const exact = warnings.filter((w) => w.pinPoint).length;
  const closed = warnings.filter((w) => w.windowEndKnown).length;
  const lead =
    closed === n
      ? `${n} stop${n === 1 ? " is" : "s are"} planned to arrive after the customer window closes.`
      : closed === 0
        ? `${n} stop${n === 1 ? " is" : "s are"} planned well after the customer window opens. Goodshuffle has no window end for ${n === 1 ? "it" : "them"}, so check with the customer.`
        : `${n} stops are planned past the customer window (${closed} after it closes, ${n - closed} well after it opens with no window end in Goodshuffle).`;
  return [
    `*${truck} on ${date}: sequencing check*`,
    `${lead} Consider moving ${n === 1 ? "it" : "them"} earlier, or call the customer ahead.`,
    ...(exact > 0 ? [`${exact === 1 ? "One is a paid exact time window" : `${exact} are paid exact time windows`}. Fix ${exact === 1 ? "that one" : "those"} first.`] : []),
    ...warnings.map((w) => `• ${w.pinPoint ? "Exact time. " : ""}${w.message}`),
  ].join("\n");
}

export async function alertRouteRisks(route: Route, truckLabel?: string): Promise<void> {
  try {
    await alertStacking(route, truckLabel);
  } catch (e) {
    console.error("[routeRisk] stacking check failed:", e);
  }
  try {
    const risky = route.stops
      .map((s) => ({ stop: s, r: reviewStopAddress({ address: s.address, name: s.custName, whenIso: s.plannedWindow || s.eta }) }))
      .filter((x) => x.r.hoursRisk);
    if (risky.length === 0) {
      seen.delete(route.routeId);
      return;
    }
    // Only alert when the risky set changes (a fresh pull of the same route is a no-op).
    const sig = risky.map((x) => x.stop.stopId).sort().join(",");
    if (seen.get(route.routeId) === sig) return;
    seen.set(route.routeId, sig);

    const truck = truckLabel || route.truckId;
    const lines = risky.map(
      (x) => `• Stop ${x.stop.sequence} · ${x.stop.custName || "—"} · ${x.stop.address || "no address"} — ${x.r.note}`,
    );
    await slackNotify(
      `🏢 *${truck} — business-hours check*\n${risky.length} stop${risky.length === 1 ? "" : "s"} at a business scheduled when it may be closed. Call ahead to confirm access:\n${lines.join("\n")}`,
    );
  } catch (e) {
    console.error("[routeRisk] failed:", e);
  }
}

async function alertStacking(route: Route, truckLabel?: string): Promise<void> {
  // Upcoming, still-open routes only: a closed or past route can no longer be resequenced.
  if (route.status === "done" || route.date < todayInOpsTz()) return;
  const warnings = stackingWarnings(routePlanStops(route)).filter((w) => {
    const s = route.stops.find((x) => x.stopId === w.stopId);
    return s && s.state === "Waiting";
  });
  if (warnings.length === 0) {
    stackSeen.delete(route.routeId);
    return;
  }
  // Re-alert only when the set of flagged stops (or their cause) changes.
  const sig = warnings.map((w) => `${w.stopId}:${w.cause}`).sort().join(",");
  if (stackSeen.get(route.routeId) === sig) return;
  stackSeen.set(route.routeId, sig);
  await slackNotify(formatStackAlert(truckLabel || route.truckId, route.date, warnings));
}
