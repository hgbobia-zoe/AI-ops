// AI Operations Manager (MVP7) — gathers the real signals from every blade and hands them to the
// pure ranker. Async because it pulls the (Connecteam-backed) finance period. Every input is a
// value another system already computed; this layer only prioritizes.

import { todayInOpsTz } from "@/lib/dates";
import { getRiskQueue } from "@/lib/risk/store";
import { salesOverview } from "@/lib/sales/service";
import { customerOverview } from "@/lib/customer/service";
import { financeForPeriod } from "@/lib/finance/service";
import { getPeriod } from "@/lib/finance/periods";
import { financeConfig } from "@/lib/finance/config";
import { buildAttention, summarize, opsBrief, type AttentionItem, type OpsInputs, type OpsSummary, type RiskSignal } from "./manager";

function daysUntil(today: string, date?: string): number | null {
  if (!date) return null;
  const b = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(b)) return null;
  return Math.round((b - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export interface OpsOverview {
  today: string;
  items: AttentionItem[];
  summary: OpsSummary;
  brief: string;
  laborVerified: boolean;
}

export async function opsOverview(): Promise<OpsOverview> {
  const today = todayInOpsTz();

  const risks: RiskSignal[] = getRiskQueue().map((r) => ({
    severity: r.severity as RiskSignal["severity"],
    title: r.title,
    description: r.description,
    recommendedAction: r.recommendedAction,
    date: r.date,
    daysUntil: daysUntil(today, r.date),
    signature: r.signature,
  }));

  const nearTermGaps = salesOverview(8).pipeline.filter((b) => b.nearTermGap).map((b) => ({ label: b.label }));
  const dormantCount = customerOverview().dormant.length;

  // Finance touches Connecteam; if it's unreachable we simply omit the labor signal (never guess).
  let labor: OpsInputs["labor"] | undefined;
  let laborVerified = false;
  try {
    const fin = await financeForPeriod(getPeriod("thisWeek"));
    laborVerified = fin.laborVerified;
    labor = {
      verified: fin.laborVerified,
      costVarianceValue: fin.labor.costVariance.variance,
      costVariancePct: fin.labor.costVariance.variancePct,
      favorable: fin.labor.costVariance.favorable,
      alertPct: financeConfig().laborVarianceAlertPct,
    };
  } catch {
    labor = undefined;
  }

  const items = buildAttention({ risks, nearTermGaps, labor, dormantCount });
  const summary = summarize(items);
  return { today, items, summary, brief: opsBrief(items, summary), laborVerified };
}
