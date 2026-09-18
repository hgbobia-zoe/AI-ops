// Opportunity Radar — meaningful-only alerts (§18). A re-pull can touch many opportunities; we alert
// only on genuinely notable signals and never twice for the same one (idempotent via
// opportunity_alerts). Alerts go to the customer-alerts Slack channel (slackNotifyAlert), which no-ops
// cleanly when unconfigured. The dedup key is recorded even when Slack is off, so wiring a webhook
// later does NOT blast the backlog.

import { getDb } from "@/lib/db";
import { slackNotifyAlert, slackAlertConfigured } from "@/lib/notify/slack";
import { DEFAULT_OPPORTUNITY_CONFIG } from "./config";
import { JURISDICTION_LABEL } from "./types";
import { singleView } from "./service";

export interface AlertItem {
  opportunityId: string;
  isNew: boolean;
  changeLabels: string[]; // deadline/status change labels
  awardee?: string | null;
}

export type AlertKind = "high_value" | "new_contractor" | "opportunity_change" | "relationship_signal";

function alreadyAlerted(key: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM opportunity_alerts WHERE alert_key = ?").get(key);
}
function recordAlert(key: string, opportunityId: string, kind: AlertKind, detail: string | undefined, now: Date): void {
  getDb().prepare("INSERT OR IGNORE INTO opportunity_alerts (alert_key, opportunity_id, kind, detail, ts) VALUES (?,?,?,?,?)")
    .run(key, opportunityId, kind, detail ?? null, now.toISOString());
}

function fmtMoney(v: { low: number; high: number } | null): string {
  if (!v) return "value TBD";
  const f = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);
  return v.low === v.high ? f(v.high) : `${f(v.low)}–${f(v.high)}`;
}

/** Fire once per (opportunity, kind, detail). Records the key regardless; posts only when Slack is on. */
async function fire(kind: AlertKind, opportunityId: string, detail: string | undefined, text: string, now: Date): Promise<number> {
  const key = `${opportunityId}:${kind}:${detail ?? ""}`;
  if (alreadyAlerted(key)) return 0;
  recordAlert(key, opportunityId, kind, detail, now);
  if (slackAlertConfigured()) {
    try { await slackNotifyAlert(`📡 ${text}`); } catch { /* never let a Slack failure break a pull */ }
  }
  return 1;
}

/** Evaluate touched opportunities and emit the meaningful alerts. Returns how many new alerts fired. */
export async function emitOpportunityAlerts(items: AlertItem[], now: Date = new Date()): Promise<number> {
  const cfg = DEFAULT_OPPORTUNITY_CONFIG.alerts;
  let posted = 0;
  for (const item of items) {
    const v = singleView(item.opportunityId);
    if (!v) continue;
    const where = JURISDICTION_LABEL[v.opp.jurisdiction];
    const target = v.primaryTarget ? v.primaryTarget.edge.entity.name : "no target yet";

    if (item.isNew && v.score.tier !== "UNQUALIFIED" && ((v.value?.high ?? 0) >= cfg.minValueHigh || v.score.opportunityScore >= cfg.minOpportunityScore)) {
      posted += await fire("high_value", v.opp.id, undefined, `High-value opportunity: ${v.opp.name} (${where}), ${fmtMoney(v.value)}, score ${v.score.opportunityScore}. Target: ${target}.`, now);
    }
    if (item.isNew) {
      for (const edge of v.entities) {
        if (edge.entity.matchedCustomerKey) {
          posted += await fire("relationship_signal", v.opp.id, edge.entity.id, `Existing Zoe relationship "${edge.entity.name}" appears on a new opportunity: ${v.opp.name} (${where}).`, now);
        }
      }
    }
    if (item.awardee) {
      posted += await fire("new_contractor", v.opp.id, item.awardee, `New contractor: "${item.awardee}" awarded on ${v.opp.name} (${where}) — a potential Zoe partner/customer.`, now);
    }
    for (const label of item.changeLabels) {
      if (/^awarded to /i.test(label)) continue; // handled via awardee
      posted += await fire("opportunity_change", v.opp.id, label, `Opportunity changed: ${v.opp.name} (${where}) — ${label}.`, now);
    }
  }
  return posted;
}
