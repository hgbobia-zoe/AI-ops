// Opportunity Radar — analytics (§19). Deterministic funnel + breakdowns over the derived board, so we
// can eventually answer the one question that matters: OPPORTUNITY → REVENUE. All counts come from real
// stored state; indicative value ranges are labelled as such (never presented as booked revenue).

import { todayInOpsTz } from "@/lib/dates";
import { opportunityBoard, type OpportunityView } from "./service";
import { enrolledOpportunityIds, contactedOpportunityIds } from "@/lib/prospecting/store";
import { JURISDICTION_LABEL, KIND_LABEL } from "./types";

export interface FunnelStage { key: string; label: string; count: number }
export interface Breakdown { key: string; label: string; total: number; qualified: number; valueHigh: number }

export interface AnalyticsView {
  today: string;
  funnel: FunnelStage[];
  bySource: Breakdown[];
  byJurisdiction: Breakdown[];
  byKind: Breakdown[];
  totals: {
    discovered: number;
    qualified: number;
    withTarget: number;
    outreachDrafted: number;
    contacted: number;
    won: number;
    indicativePipelineHigh: number; // sum of indicative/hard value highs for qualified, non-lost
  };
}

const STAGE_BUCKETS: { key: string; label: string; match: (v: OpportunityView) => boolean }[] = [
  { key: "discovered", label: "Discovered", match: () => true },
  { key: "qualified", label: "Qualified", match: (v) => v.score.tier !== "UNQUALIFIED" },
  { key: "researching", label: "Researching+", match: (v) => ["RESEARCHING", "TARGET_IDENTIFIED", "OUTREACH_READY", "CONTACTED", "ENGAGED", "OPPORTUNITY", "QUOTED", "WON"].includes(v.stage) },
  { key: "target", label: "Target identified", match: (v) => ["TARGET_IDENTIFIED", "OUTREACH_READY", "CONTACTED", "ENGAGED", "OPPORTUNITY", "QUOTED", "WON"].includes(v.stage) },
  { key: "outreach", label: "Outreach ready", match: (v) => ["OUTREACH_READY", "CONTACTED", "ENGAGED", "OPPORTUNITY", "QUOTED", "WON"].includes(v.stage) },
  { key: "contacted", label: "Contacted", match: (v) => ["CONTACTED", "ENGAGED", "OPPORTUNITY", "QUOTED", "WON"].includes(v.stage) },
  { key: "opportunity", label: "In Sales OS", match: (v) => v.opp.salesStatus !== "NONE" || ["OPPORTUNITY", "QUOTED", "WON"].includes(v.stage) },
  { key: "won", label: "Won", match: (v) => v.stage === "WON" },
];

function accumulate(rows: OpportunityView[], keyOf: (v: OpportunityView) => string, labelOf: (k: string) => string): Breakdown[] {
  const map = new Map<string, Breakdown>();
  for (const v of rows) {
    const key = keyOf(v);
    const b = map.get(key) ?? { key, label: labelOf(key), total: 0, qualified: 0, valueHigh: 0 };
    b.total++;
    if (v.score.tier !== "UNQUALIFIED") b.qualified++;
    b.valueHigh += v.value?.high ?? 0;
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export function opportunityAnalytics(today: string = todayInOpsTz()): AnalyticsView {
  const board = opportunityBoard(today);
  const rows = board.all;

  const funnel = STAGE_BUCKETS.map((s) => ({ key: s.key, label: s.label, count: rows.filter(s.match).length }));

  const bySource = accumulate(rows, (v) => v.opp.sourceName ?? v.opp.sourceId ?? "unknown", (k) => k);
  const byJurisdiction = accumulate(rows, (v) => v.opp.jurisdiction, (k) => JURISDICTION_LABEL[k as keyof typeof JURISDICTION_LABEL] ?? k);
  const byKind = accumulate(rows, (v) => v.opp.kind, (k) => KIND_LABEL[k as keyof typeof KIND_LABEL] ?? k);

  const enrolled = enrolledOpportunityIds();
  const contactedSet = contactedOpportunityIds();
  let outreachDrafted = 0;
  let contacted = 0;
  for (const v of rows) {
    if (enrolled.has(v.opp.id)) outreachDrafted++;
    if (contactedSet.has(v.opp.id) || ["CONTACTED", "ENGAGED", "OPPORTUNITY", "QUOTED", "WON"].includes(v.stage)) contacted++;
  }

  const totals = {
    discovered: rows.length,
    qualified: rows.filter((v) => v.score.tier !== "UNQUALIFIED").length,
    withTarget: rows.filter((v) => v.primaryTarget != null).length,
    outreachDrafted,
    contacted,
    won: rows.filter((v) => v.stage === "WON").length,
    indicativePipelineHigh: rows.filter((v) => v.score.tier !== "UNQUALIFIED" && v.stage !== "LOST").reduce((s, v) => s + (v.value?.high ?? 0), 0),
  };

  return { today, funnel, bySource, byJurisdiction, byKind, totals };
}
