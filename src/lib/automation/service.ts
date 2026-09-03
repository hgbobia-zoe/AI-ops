// Controlled Automation (MVP8) — assembles the observe-mode action queue from live signals.
// Gathers real risks + booking gaps, proposes actions (pure), records them to the observe log,
// and returns them for display. Executes nothing.

import { getRiskQueue } from "@/lib/risk/store";
import { salesOverview } from "@/lib/sales/service";
import { proposeFromRisks, proposeFromGaps, orderProposals, type ProposedAction, type Tier, type Target } from "./actions";
import { observeProposals } from "./store";

export interface ObservedAction extends ProposedAction {
  firstObservedAt: string;
}

export interface AutomationOverview {
  proposals: ObservedAction[];
  total: number;
  byTier: Record<Tier, number>;
  byTarget: Record<Target, number>;
  outwardCount: number;
}

export function automationOverview(): AutomationOverview {
  const risks = getRiskQueue().map((r) => ({
    signature: r.signature,
    riskType: r.riskType,
    severity: r.severity,
    title: r.title,
    description: r.description,
    recommendedAction: r.recommendedAction,
    actionTarget: r.actionTarget,
    date: r.date,
    eventId: r.eventId,
    routeId: r.routeId,
  }));
  const gaps = salesOverview(8).pipeline.filter((b) => b.nearTermGap).map((b) => ({ label: b.label }));

  const proposals = orderProposals([...proposeFromRisks(risks), ...proposeFromGaps(gaps)]);
  const observed = observeProposals(proposals);
  const withDates: ObservedAction[] = proposals.map((p) => ({ ...p, firstObservedAt: observed.get(p.key) ?? "" }));

  const byTier: Record<Tier, number> = { observe: 0, recommend: 0, prepare: 0, approve: 0, auto: 0 };
  const byTarget: Record<Target, number> = { dispatch: 0, connecteam: 0, goodshuffle: 0, slack: 0, internal: 0 };
  let outwardCount = 0;
  for (const p of withDates) {
    byTier[p.tier]++;
    byTarget[p.target]++;
    if (p.outward) outwardCount++;
  }

  return { proposals: withDates, total: withDates.length, byTier, byTarget, outwardCount };
}
