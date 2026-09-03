// Proactive route-risk alerts → Slack. Runs when a route is imported/pulled, so dispatch
// hears about a problem the moment the route lands — not when someone happens to open the
// board. Currently: business/office stops scheduled outside open hours (a truck showing
// up while the place is closed). Throttled per route+risk-set so auto-pull can't spam.

import type { Route } from "@/lib/types";
import { reviewStopAddress } from "@/lib/addressReview";
import { slackNotify } from "./slack";

const g = globalThis as unknown as { __routeRiskSeen?: Map<string, string> };
const seen = (g.__routeRiskSeen ??= new Map<string, string>());

export async function alertRouteRisks(route: Route, truckLabel?: string): Promise<void> {
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
