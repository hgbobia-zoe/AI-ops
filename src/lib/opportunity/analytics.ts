// Opportunity Radar — analytics (§19). Deterministic funnel + breakdowns over the derived board, so we
// can eventually answer the one question that matters: OPPORTUNITY → REVENUE. All counts come from real
// stored state. Dollar values are only what a source stated or what Goodshuffle booked; never estimated.

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
    statedValueTotal: number; // sum of values STATED BY SOURCES (qualified, not lost); no estimates
    withValueData: number; // how many of those have a stated value at all
    inGoodshuffle: number; // converted (intent confirmed) and linked to a Goodshuffle project
    signedBookings: number; // linked projects with a signed contract
    bookedRevenue: number; // SIGNED: contract totals of signed linked projects (dollars, from Goodshuffle)
    realizedRevenue: number; // REALIZED: signed linked projects whose event date has passed
  };
  /** Signed revenue per acquisition source. Each Goodshuffle project counts once, under the first
   *  opportunity (by conversion) that links to it, so revenue is never double counted. */
  revenueBySource: { key: string; label: string; projects: number; signed: number; bookedRevenue: number; realizedRevenue: number }[];
}

/** PURE. Signed and realized revenue per source, counting each booking once (first linked opportunity). */
export function attributeRevenue(rows: Pick<OpportunityView, "opp" | "booking">[]): {
  bySource: AnalyticsView["revenueBySource"];
  totals: { inGoodshuffle: number; signedBookings: number; bookedRevenue: number; realizedRevenue: number };
} {
  const seen = new Set<string>();
  const map = new Map<string, AnalyticsView["revenueBySource"][number]>();
  const totals = { inGoodshuffle: 0, signedBookings: 0, bookedRevenue: 0, realizedRevenue: 0 };
  const linked = rows.filter((v) => v.opp.bookingId).sort((a, b) => (a.opp.discoveredAt ?? "").localeCompare(b.opp.discoveredAt ?? ""));
  for (const v of linked) {
    const id = v.opp.bookingId!;
    if (seen.has(id)) continue;
    seen.add(id);
    const key = v.opp.sourceName ?? v.opp.sourceId ?? "unknown";
    const s = map.get(key) ?? { key, label: key, projects: 0, signed: 0, bookedRevenue: 0, realizedRevenue: 0 };
    s.projects++;
    totals.inGoodshuffle++;
    if (v.booking?.signed) {
      const amt = v.booking.contractTotal ?? 0;
      s.signed++;
      s.bookedRevenue += amt;
      totals.signedBookings++;
      totals.bookedRevenue += amt;
      if (v.booking.realized) {
        s.realizedRevenue += amt;
        totals.realizedRevenue += amt;
      }
    }
    map.set(key, s);
  }
  return { bySource: [...map.values()].sort((a, b) => b.bookedRevenue - a.bookedRevenue || b.projects - a.projects), totals };
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

/** Real records only by default: demo / seed rows never count toward the funnel or pipeline. */
export function opportunityAnalytics(today: string = todayInOpsTz(), opts: { includeSeed?: boolean } = {}): AnalyticsView {
  const board = opportunityBoard(today);
  const rows = opts.includeSeed ? board.all : board.all.filter((v) => !v.opp.isSeed);

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

  const revenue = attributeRevenue(rows);
  const totals = {
    ...revenue.totals,
    discovered: rows.length,
    qualified: rows.filter((v) => v.score.tier !== "UNQUALIFIED").length,
    withTarget: rows.filter((v) => v.primaryTarget != null).length,
    outreachDrafted,
    contacted,
    won: rows.filter((v) => v.stage === "WON").length,
    statedValueTotal: rows.filter((v) => v.score.tier !== "UNQUALIFIED" && v.stage !== "LOST").reduce((s, v) => s + (v.value?.high ?? 0), 0),
    withValueData: rows.filter((v) => v.score.tier !== "UNQUALIFIED" && v.stage !== "LOST" && v.value).length,
  };

  return { today, funnel, bySource, byJurisdiction, byKind, totals, revenueBySource: revenue.bySource };
}
