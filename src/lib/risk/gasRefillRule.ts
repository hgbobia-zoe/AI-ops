// Route checker for the gas tank refill (dispatch/gasRefill.ts): every route that picks up a gas tank must
// have the refill stop, or (when it gets there after closing) the office's next-day task. Neither means
// the tanks come back empty, so it is a HIGH finding: it shows on /risk, feeds the exception engine, and is
// posted to Slack like every HIGH. It auto-resolves once the stop or the task exists (the scan stops
// emitting it). A route already closed out is past fixing and isn't flagged.

import type { Route } from "@/lib/types";
import type { RiskFinding } from "./types";
import { gasRefillCovered, gasTaskDedupeKey, triggerSummary } from "@/lib/dispatch/gasRefill";

export function gasRefillFindings(routes: Route[], keywords: string[], taskExists: (dedupeKey: string) => boolean, truckLabel: (truckId: string) => string = (t) => t): RiskFinding[] {
  const out: RiskFinding[] = [];
  for (const r of routes) {
    if (r.status === "done") continue;
    const v = gasRefillCovered(r.stops, keywords, taskExists(gasTaskDedupeKey(r.routeId)));
    if (!v.needed || v.covered) continue;
    const summary = triggerSummary(v.triggers);
    const from = v.triggers.map((t) => t.custName).join(", ");
    out.push({
      signature: `gas_refill_missing|${r.routeId}`,
      riskType: "gas_refill_missing",
      category: "PICKUP",
      severity: "HIGH",
      title: "Gas tanks picked up with no refill planned",
      description: `${truckLabel(r.truckId)} picks up gas tanks (${summary}) from ${from}, but the route has no gas refill stop and no next-day refill task, so the tanks would come back empty.`,
      date: r.date,
      eventId: v.triggers.find((t) => t.txId)?.txId,
      routeId: r.routeId,
      truckId: r.truckId,
      affectedEntity: summary,
      recommendedAction: "Re-pull the route so Dispatch adds the refill stop, or set a task for the office to refill the tanks the next day.",
      actionTarget: "dispatch",
      owner: "Dispatch",
      metadata: { triggers: v.triggers },
    });
  }
  return out;
}
