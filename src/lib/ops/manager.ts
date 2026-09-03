// AI Operations Manager (MVP7) — the synthesis layer. It does NOT hold its own data or make
// decisions; it ranks the signals the other blades already computed into one "what needs
// attention" feed, deterministically. RULES CALCULATE: every item traces to a real signal, the
// score is a pure function, and the brief is templated from counts — nothing is invented.

export type Priority = "critical" | "high" | "medium" | "info";

export interface AttentionItem {
  key: string;
  priority: Priority;
  score: number; // higher = more urgent
  title: string;
  detail: string;
  source: "risk" | "sales" | "finance" | "customer";
  href: string;
  daysUntil?: number | null;
}

export interface RiskSignal {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  title: string;
  description: string;
  recommendedAction?: string;
  date?: string;
  daysUntil?: number | null;
  signature: string;
  /** The event's booked revenue ($), when known — raises a risk's priority (a $15k event at risk
   *  deserves attention over a minor issue on a $300 one). Null/absent = no financial weight. */
  revenue?: number | null;
  /** True when the event's customer is a high-value repeat — a small extra nudge. */
  highValueCustomer?: boolean;
}

export interface OpsInputs {
  risks: RiskSignal[];
  nearTermGaps: { label: string }[];
  labor?: {
    verified: boolean;
    costVarianceValue: number | null; // $ (positive = over plan when unfavorable)
    costVariancePct: number | null; // fraction
    favorable: boolean | null;
    alertPct: number; // threshold fraction
  };
  dormantCount: number;
  /** Days classified CONSTRAINED by the capacity engine (can't clearly execute what's booked). */
  capacityConstrained?: { date: string; reasons: string[] }[];
}

const SEV_BASE: Record<RiskSignal["severity"], { score: number; priority: Priority }> = {
  CRITICAL: { score: 100, priority: "critical" },
  HIGH: { score: 70, priority: "high" },
  MEDIUM: { score: 40, priority: "medium" },
  LOW: { score: 20, priority: "info" },
};

/** Extra urgency for imminent events. Pure function of days-until. */
function urgencyBonus(daysUntil: number | null | undefined): number {
  if (daysUntil == null) return 0;
  if (daysUntil <= 0) return 18;
  if (daysUntil <= 1) return 14;
  if (daysUntil <= 3) return 8;
  if (daysUntil <= 7) return 3;
  return 0;
}

/** Financial weight — a risk on a bigger booking outranks the same risk on a small one. Bounded so
 *  it augments severity/urgency rather than swamping them. */
export function financialBonus(revenue: number | null | undefined): number {
  if (revenue == null || revenue <= 0) return 0;
  if (revenue >= 15000) return 25;
  if (revenue >= 7500) return 18;
  if (revenue >= 4000) return 12;
  if (revenue >= 1500) return 6;
  return 2;
}

/** Rank all signals into one attention feed (highest score first). */
export function buildAttention(inp: OpsInputs): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const r of inp.risks) {
    const base = SEV_BASE[r.severity];
    items.push({
      key: `risk|${r.signature}`,
      priority: base.priority,
      score: base.score + urgencyBonus(r.daysUntil) + financialBonus(r.revenue) + (r.highValueCustomer ? 5 : 0),
      title: r.title,
      detail: r.recommendedAction ? `${r.description} → ${r.recommendedAction}` : r.description,
      source: "risk",
      href: "/risk",
      daysUntil: r.daysUntil ?? null,
    });
  }

  for (const g of inp.nearTermGaps) {
    items.push({
      key: `sales|gap|${g.label}`,
      priority: "medium",
      score: 55,
      title: `No booked events — week of ${g.label}`,
      detail: "A near-term week has nothing on the board yet. Confirm nothing is missing or unbooked.",
      source: "sales",
      href: "/sales",
    });
  }

  if (
    inp.labor &&
    inp.labor.verified &&
    inp.labor.favorable === false &&
    inp.labor.costVariancePct != null &&
    Math.abs(inp.labor.costVariancePct) >= inp.labor.alertPct
  ) {
    const pctTxt = `${Math.round(Math.abs(inp.labor.costVariancePct) * 100)}%`;
    const dollarTxt = inp.labor.costVarianceValue != null ? ` (${inp.labor.costVarianceValue >= 0 ? "+" : "-"}$${Math.abs(Math.round(inp.labor.costVarianceValue)).toLocaleString("en-US")})` : "";
    items.push({
      key: "finance|labor-overrun",
      priority: "medium",
      score: 60,
      title: `Labor cost ${pctTxt} over plan${dollarTxt}`,
      detail: "Actual labor is running above the scheduled plan this period. Review hours vs. what was booked.",
      source: "finance",
      href: "/finance",
    });
  }

  for (const c of inp.capacityConstrained ?? []) {
    items.push({
      key: `capacity|${c.date}`,
      priority: "high",
      score: 64,
      title: `Capacity constrained — ${c.date}`,
      detail: `${c.reasons.join("; ")}. Can we execute everything booked that day?`,
      source: "risk",
      href: "/risk",
    });
  }

  if (inp.dormantCount > 0) {
    items.push({
      key: "customer|winback",
      priority: "info",
      score: 15,
      title: `${inp.dormantCount} repeat customer${inp.dormantCount === 1 ? "" : "s"} gone quiet`,
      detail: "Past repeat customers with no booking in 12+ months — win-back candidates.",
      source: "customer",
      href: "/customers",
    });
  }

  return items.sort((a, b) => b.score - a.score);
}

export interface OpsSummary {
  critical: number;
  high: number;
  medium: number;
  info: number;
  total: number;
}

export function summarize(items: AttentionItem[]): OpsSummary {
  const s: OpsSummary = { critical: 0, high: 0, medium: 0, info: 0, total: items.length };
  for (const i of items) s[i.priority]++;
  return s;
}

/** A plain-language brief built ONLY from the computed counts — no LLM, no invented facts.
 *  (An LLM interpretation layer can be added later; it would summarize these same facts.) */
export function opsBrief(items: AttentionItem[], sum: OpsSummary): string {
  if (sum.total === 0) return "Nothing needs attention right now — no active risks, near-term booking gaps, or labor overruns.";
  const parts: string[] = [];
  if (sum.critical > 0) parts.push(`${sum.critical} critical item${sum.critical === 1 ? "" : "s"} need immediate action`);
  if (sum.high > 0) parts.push(`${sum.high} high-priority`);
  if (sum.medium > 0) parts.push(`${sum.medium} to review`);
  const lead = parts.length ? parts.join(", ") + "." : "";
  const top = items[0];
  const focus = top ? ` Start with: ${top.title}.` : "";
  return `${lead}${focus}`.trim();
}
