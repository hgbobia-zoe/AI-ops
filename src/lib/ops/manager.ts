// AI Operations Manager (MVP7) — the synthesis layer. It does NOT hold its own data or make
// decisions; it ranks the signals the other blades already computed into one "what needs
// attention" feed, deterministically. RULES CALCULATE: every item traces to a real signal, the
// score is a pure function, and the brief is templated from counts — nothing is invented.

export type Priority = "critical" | "high" | "medium" | "info";

/** The signal's own workflow/lifecycle status, SEPARATE from its severity and its due date. */
export type ItemStatus = "open" | "acknowledged" | "in_progress";

export type Source = "risk" | "sales" | "finance" | "customer";

export interface AttentionItem {
  key: string;
  /** Derived RANKING bucket (a function of severity + urgency + weight). Distinct from `severity`. */
  priority: Priority;
  score: number; // higher = more urgent
  title: string;
  detail: string;
  source: Source;
  /** The owning blade (generic). Kept for backward compatibility; the UI prefers `focusHref`. */
  href: string;

  // ── Separated dimensions (the redesign splits what used to be conflated into `priority`) ──
  /** The signal's intrinsic severity, independent of how soon it is due or its workflow status. */
  severity: Priority;
  /** Workflow status (risk lifecycle; synthesized signals are always "open"). */
  status: ItemStatus;
  /** Affected day (YYYY-MM-DD) when the signal is tied to one; null for date-agnostic signals. */
  date?: string | null;
  daysUntil?: number | null;

  // ── Human-readable anatomy (affected day/event · problem · impact · owner · next action) ──
  owner?: string | null;
  /** Short problem statement. */
  problem: string;
  /** The consequence if nothing is done. */
  impact: string;
  /** The concrete recommended next step. */
  nextAction: string;
  /** A FOCUSED destination that preserves the affected date/context (never a bare generic blade). */
  focusHref: string;
  focusLabel: string;
  /** A human label for the affected event/day (e.g. the event name), when known. */
  affectedLabel?: string | null;
  eventId?: string | null;

  // ── Provenance ──
  /** Why this item is prioritized — the ranking rationale, in plain pieces. */
  reasons: string[];
  /** When this signal was last evaluated (ISO). Lets the UI say "evaluated 10m ago", not "now". */
  evaluatedAt?: string | null;
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
  /** Workflow status from the risk lifecycle (OPEN/ACKNOWLEDGED/IN_PROGRESS). */
  status?: "OPEN" | "ACKNOWLEDGED" | "IN_PROGRESS";
  /** Assigned owner, when a human has taken it. */
  owner?: string | null;
  /** Where the fix happens (connecteam | dispatch | goodshuffle) — drives the focused destination. */
  actionTarget?: string | null;
  /** The affected event id, for grouping sibling signals on the same event. */
  eventId?: string | null;
  /** Human label for the affected event/entity. */
  affectedEntity?: string | null;
  /** When this risk was last evaluated by the scanner (ISO). */
  evaluatedAt?: string | null;
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
  /** When the synthesized (non-risk) signals were evaluated (ISO). Defaults to undefined. */
  evaluatedAt?: string | null;
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

/** A plain-language "how soon" phrase for a due date. */
function duePhrase(daysUntil: number | null | undefined): string | null {
  if (daysUntil == null) return null;
  if (daysUntil < 0) return `${-daysUntil}d overdue`;
  if (daysUntil === 0) return "today";
  if (daysUntil === 1) return "tomorrow";
  return `in ${daysUntil}d`;
}

const STATUS_MAP: Record<NonNullable<RiskSignal["status"]>, ItemStatus> = {
  OPEN: "open",
  ACKNOWLEDGED: "acknowledged",
  IN_PROGRESS: "in_progress",
};

const SEV_WORD: Record<Priority, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  info: "Low",
};

/** The focused destination for a risk — carries the affected date where the target supports it,
 *  so a click lands on the day/context, never a bare blade. Falls back to the risk board (where the
 *  acknowledgment workflow lives). */
function riskFocus(
  actionTarget: string | null | undefined,
  date: string | undefined,
): { href: string; label: string } {
  if (actionTarget === "dispatch") {
    return date
      ? { href: `/dispatch?date=${date}`, label: "Open dispatch for the day" }
      : { href: "/dispatch", label: "Open dispatch" };
  }
  return { href: "/risk", label: "Review on the risk board" };
}

/** Rank all signals into one attention feed (highest score first). */
export function buildAttention(inp: OpsInputs): AttentionItem[] {
  const items: AttentionItem[] = [];
  const evalAt = inp.evaluatedAt ?? null;

  for (const r of inp.risks) {
    const base = SEV_BASE[r.severity];
    const uBonus = urgencyBonus(r.daysUntil);
    const fBonus = financialBonus(r.revenue);
    const reasons: string[] = [`${SEV_WORD[base.priority]} severity`];
    const due = duePhrase(r.daysUntil);
    if (uBonus > 0 && due) reasons.push(`event ${due}`);
    if (fBonus > 0) reasons.push("weighted up for booking value");
    if (r.highValueCustomer) reasons.push("repeat high-value customer");
    const focus = riskFocus(r.actionTarget, r.date);
    items.push({
      key: `risk|${r.signature}`,
      priority: base.priority,
      score: base.score + uBonus + fBonus + (r.highValueCustomer ? 5 : 0),
      title: r.title,
      detail: r.recommendedAction ? `${r.description} → ${r.recommendedAction}` : r.description,
      source: "risk",
      href: "/risk",
      severity: base.priority,
      status: r.status ? STATUS_MAP[r.status] : "open",
      date: r.date ?? null,
      daysUntil: r.daysUntil ?? null,
      owner: r.owner ?? null,
      problem: r.description,
      impact: r.affectedEntity
        ? `Affects ${r.affectedEntity}${due ? ` (${due})` : ""}.`
        : due
          ? `Event is ${due}.`
          : "Open event risk.",
      nextAction: r.recommendedAction ?? "Review and assign an owner.",
      focusHref: focus.href,
      focusLabel: focus.label,
      affectedLabel: r.affectedEntity ?? null,
      eventId: r.eventId ?? null,
      reasons,
      evaluatedAt: r.evaluatedAt ?? evalAt,
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
      severity: "medium",
      status: "open",
      date: null,
      owner: null,
      problem: `The week of ${g.label} has no booked events on the board.`,
      impact: "A near-term empty week may be a booking slipping through or an unconfirmed hold.",
      nextAction: "Confirm nothing is missing or unbooked for that week.",
      focusHref: "/sales",
      focusLabel: "Open sales pipeline",
      affectedLabel: `Week of ${g.label}`,
      reasons: ["Near-term week with zero bookings"],
      evaluatedAt: evalAt,
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
      severity: "medium",
      status: "open",
      date: null,
      owner: null,
      problem: `Actual labor is running ${pctTxt} above the scheduled plan this period${dollarTxt}.`,
      impact: "Margins on this period's work erode if the overrun continues unexamined.",
      nextAction: "Review hours against what was booked for the period.",
      focusHref: "/finance",
      focusLabel: "Open finance",
      affectedLabel: "This week",
      reasons: [`Labor ${pctTxt} over plan (past the alert threshold)`],
      evaluatedAt: evalAt,
    });
  }

  for (const c of inp.capacityConstrained ?? []) {
    const reasonsTxt = c.reasons.join("; ");
    items.push({
      key: `capacity|${c.date}`,
      priority: "high",
      score: 64,
      title: `Capacity constrained — ${c.date}`,
      detail: `${reasonsTxt}. Can we execute everything booked that day?`,
      source: "risk",
      href: "/risk",
      severity: "high",
      status: "open",
      date: c.date,
      daysUntil: null,
      owner: null,
      problem: reasonsTxt || "The capacity engine flagged this day as constrained.",
      impact: "The day may not be executable as booked without a change.",
      nextAction: "Confirm the day can run as booked, or rebalance routes/crew.",
      focusHref: `/dispatch?date=${c.date}`,
      focusLabel: "Open dispatch for the day",
      affectedLabel: c.date,
      reasons: ["Capacity engine verdict: CONSTRAINED"],
      evaluatedAt: evalAt,
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
      severity: "info",
      status: "open",
      date: null,
      owner: null,
      problem: `${inp.dormantCount} past repeat customer${inp.dormantCount === 1 ? " has" : "s have"} not booked in 12+ months.`,
      impact: "Dormant repeat customers are the cheapest revenue to win back.",
      nextAction: "Review win-back candidates and reach out.",
      focusHref: "/customers",
      focusLabel: "Open customers",
      affectedLabel: "Win-back",
      reasons: ["Repeat customers inactive 12+ months"],
      evaluatedAt: evalAt,
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

// ── Filtering (pure, so it is testable and shared by the server + client) ────────────────────────

/** Coarse due-date buckets. `all` = no constraint. */
export type DateBucket = "all" | "overdue" | "today" | "soon" | "week" | "later" | "undated";

/** Map a days-until value to its bucket. Null/absent → "undated". */
export function dateBucketOf(daysUntil: number | null | undefined): Exclude<DateBucket, "all"> {
  if (daysUntil == null) return "undated";
  if (daysUntil < 0) return "overdue";
  if (daysUntil === 0) return "today";
  if (daysUntil <= 3) return "soon";
  if (daysUntil <= 7) return "week";
  return "later";
}

export const UNASSIGNED = "__unassigned__";

export interface AttentionFilter {
  priority?: Priority | null;
  dateBucket?: DateBucket | null;
  /** A specific owner name, the `UNASSIGNED` sentinel, or null/"all" for every owner. */
  owner?: string | null;
}

/** Filter the feed by any combination of priority / due-date bucket / owner. Pure. */
export function filterAttention(items: AttentionItem[], f: AttentionFilter): AttentionItem[] {
  return items.filter((it) => {
    if (f.priority && it.priority !== f.priority) return false;
    if (f.dateBucket && f.dateBucket !== "all" && dateBucketOf(it.daysUntil) !== f.dateBucket) return false;
    if (f.owner && f.owner !== "all") {
      const o = it.owner ?? null;
      if (f.owner === UNASSIGNED) return o == null;
      return o === f.owner;
    }
    return true;
  });
}

/** Distinct owners present in the feed (sorted), plus whether any item is unassigned. */
export function ownersOf(items: AttentionItem[]): { owners: string[]; hasUnassigned: boolean } {
  const set = new Set<string>();
  let hasUnassigned = false;
  for (const it of items) {
    if (it.owner) set.add(it.owner);
    else hasUnassigned = true;
  }
  return { owners: [...set].sort((a, b) => a.localeCompare(b)), hasUnassigned };
}

// ── Grouping (pure) ──────────────────────────────────────────────────────────────────────────────
// Related signals on the SAME DAY (e.g. a missing driver + the resulting capacity constraint) are
// clustered so the day reads as one situation — but every child issue is retained with its own
// severity, rules and evidence. Grouping is purely presentational: it never drops a signal or
// changes a score. A day with only one signal stays a standalone row.

export interface AttentionGroup {
  key: string;
  kind: "day" | "single";
  date?: string | null;
  /** The highest child score (groups are ordered by this, preserving the overall ranking). */
  topScore: number;
  /** The highest child priority bucket (for the group's header indicator). */
  topPriority: Priority;
  items: AttentionItem[];
}

export function groupAttention(items: AttentionItem[]): AttentionGroup[] {
  // `items` is expected score-sorted (buildAttention guarantees it); preserve that order.
  const byDate = new Map<string, AttentionItem[]>();
  for (const it of items) {
    if (it.date) {
      const arr = byDate.get(it.date) ?? [];
      arr.push(it);
      byDate.set(it.date, arr);
    }
  }
  const multiDays = new Set([...byDate.entries()].filter(([, v]) => v.length >= 2).map(([k]) => k));

  const groups: AttentionGroup[] = [];
  const emitted = new Set<string>();
  for (const it of items) {
    if (it.date && multiDays.has(it.date)) {
      const dayKey = `day:${it.date}`;
      if (emitted.has(dayKey)) continue;
      emitted.add(dayKey);
      const members = byDate.get(it.date)!; // already in score order
      groups.push({
        key: dayKey,
        kind: "day",
        date: it.date,
        topScore: members[0].score,
        topPriority: members[0].priority,
        items: members,
      });
    } else {
      groups.push({
        key: `single:${it.key}`,
        kind: "single",
        date: it.date ?? null,
        topScore: it.score,
        topPriority: it.priority,
        items: [it],
      });
    }
  }
  return groups;
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
