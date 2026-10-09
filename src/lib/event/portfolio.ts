// Portfolio view-model — PURE (no DB/net/AI/UI). Phase-6 UI helper.
//
// Governing law: RULES CALCULATE, AI INTERPRETS — the UI RENDERS. This module holds the small, pure
// bucketing/filtering/grouping/sorting the /events portfolio needs. It takes ALREADY-RESOLVED rows (each
// a cheap { ref, lifecycle, condition, value } the page resolves boundedly + guarded) and computes the
// summary strip + the filtered/grouped list deterministically. It computes NO event state itself — the
// lifecycle + condition on each row come straight from the engine (deriveLifecycle / computeEventReadiness).
// It never fabricates a value: a redacted/unknown dollar figure stays null.

import type { EventCondition, EventRef } from "./types";
import { LIFECYCLE_ORDER, type LifecycleState } from "./machine";

/** One resolved portfolio row — the cheap fields the list + summary need. */
export interface PortfolioRow {
  ref: EventRef;
  /** The engine's lifecycle state for this event (deriveLifecycle) — never recomputed here. */
  lifecycle: LifecycleState;
  /** The engine's readiness condition (computeEventReadiness) — never recomputed here. */
  condition: EventCondition;
  /** Event value in dollars, or null when unknown OR redacted for a non-financial role. */
  value: number | null;
}

/** The summary strip counts. Buckets intentionally OVERLAP (an event due today is also within next 7, and
 *  may also be at risk) — the strip answers "where are we" at a glance, not a partition. */
export interface PortfolioSummary {
  total: number;
  today: number;
  next7: number;
  atRisk: number; // AT_RISK or ESCALATED (escalated is the most severe at-risk)
  blocked: number; // BLOCKED
  ready: number; // lifecycle === READY
}

/** Worst-first severity rank for the readiness condition (for sorting + group order). */
export const CONDITION_RANK: Record<EventCondition, number> = {
  ESCALATED: 4,
  BLOCKED: 3,
  AT_RISK: 2,
  WATCH: 1,
  NORMAL: 0,
};

/** Whole-day difference (date − today) in days, or null when either date is missing/invalid. PURE, tz-safe
 *  (both pinned to UTC midnight). Negative = in the past, 0 = today, positive = upcoming. */
export function daysUntil(date: string | null | undefined, today: string): number | null {
  if (!date) return null;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The summary strip counts over the resolved rows. PURE. */
export function summarizePortfolio(rows: PortfolioRow[], today: string): PortfolioSummary {
  const s: PortfolioSummary = { total: rows.length, today: 0, next7: 0, atRisk: 0, blocked: 0, ready: 0 };
  for (const r of rows) {
    const d = daysUntil(r.ref.date, today);
    if (d === 0) s.today++;
    if (d !== null && d >= 0 && d <= 7) s.next7++;
    if (r.condition === "AT_RISK" || r.condition === "ESCALATED") s.atRisk++;
    if (r.condition === "BLOCKED") s.blocked++;
    if (r.lifecycle === "READY") s.ready++;
  }
  return s;
}

export type WindowFilter = "all" | "overdue" | "today" | "next7" | "next30";

export interface PortfolioFilter {
  lifecycle?: LifecycleState | "all";
  condition?: EventCondition | "all";
  window?: WindowFilter;
}

/** Narrow (filter is a logical AND). Unknown-dated rows are excluded by any window filter other than
 *  "all" (we can't place them on a calendar — honest). PURE. */
export function filterPortfolio(rows: PortfolioRow[], filter: PortfolioFilter, today: string): PortfolioRow[] {
  return rows.filter((r) => {
    if (filter.lifecycle && filter.lifecycle !== "all" && r.lifecycle !== filter.lifecycle) return false;
    if (filter.condition && filter.condition !== "all" && r.condition !== filter.condition) return false;
    if (filter.window && filter.window !== "all") {
      const d = daysUntil(r.ref.date, today);
      if (d === null) return false;
      if (filter.window === "overdue" && d >= 0) return false;
      if (filter.window === "today" && d !== 0) return false;
      if (filter.window === "next7" && (d < 0 || d > 7)) return false;
      if (filter.window === "next30" && (d < 0 || d > 30)) return false;
    }
    return true;
  });
}

/** Soonest-first; undated last; ties broken by worst-condition-first. Does not mutate the input. PURE. */
export function sortPortfolio(rows: PortfolioRow[], today: string): PortfolioRow[] {
  return [...rows].sort((a, b) => {
    const da = daysUntil(a.ref.date, today);
    const db = daysUntil(b.ref.date, today);
    if (da === null && db !== null) return 1;
    if (db === null && da !== null) return -1;
    if (da !== null && db !== null && da !== db) return da - db;
    return CONDITION_RANK[b.condition] - CONDITION_RANK[a.condition];
  });
}

export type GroupKey = "none" | "lifecycle" | "condition" | "window";

export interface PortfolioGroup {
  key: string;
  label: string;
  rows: PortfolioRow[];
}

const WINDOW_BUCKETS: { key: string; label: string; test: (d: number | null) => boolean }[] = [
  { key: "overdue", label: "Overdue", test: (d) => d !== null && d < 0 },
  { key: "today", label: "Today", test: (d) => d === 0 },
  { key: "next7", label: "Next 7 days", test: (d) => d !== null && d >= 1 && d <= 7 },
  { key: "next30", label: "Next 30 days", test: (d) => d !== null && d >= 8 && d <= 30 },
  { key: "later", label: "Later", test: (d) => d !== null && d > 30 },
  { key: "undated", label: "No date", test: (d) => d === null },
];

const CONDITION_LABEL: Record<EventCondition, string> = {
  ESCALATED: "Escalated",
  BLOCKED: "Blocked",
  AT_RISK: "At risk",
  WATCH: "Watch",
  NORMAL: "Normal",
};

/** Group the (already-sorted) rows for display. Empty groups are dropped; group ORDER is deterministic
 *  (lifecycle order / worst-condition-first / soonest window first). PURE. */
export function groupPortfolio(rows: PortfolioRow[], group: GroupKey, today: string): PortfolioGroup[] {
  if (group === "none") {
    return rows.length > 0 ? [{ key: "all", label: "All events", rows }] : [];
  }
  if (group === "lifecycle") {
    return LIFECYCLE_ORDER.concat(["CANCELLED", "LOST"] as LifecycleState[])
      .map((state) => ({ key: state, label: titleCase(state), rows: rows.filter((r) => r.lifecycle === state) }))
      .filter((g) => g.rows.length > 0);
  }
  if (group === "condition") {
    return (Object.keys(CONDITION_RANK) as EventCondition[])
      .sort((a, b) => CONDITION_RANK[b] - CONDITION_RANK[a])
      .map((cond) => ({ key: cond, label: CONDITION_LABEL[cond], rows: rows.filter((r) => r.condition === cond) }))
      .filter((g) => g.rows.length > 0);
  }
  // window
  return WINDOW_BUCKETS.map((b) => ({ key: b.key, label: b.label, rows: rows.filter((r) => b.test(daysUntil(r.ref.date, today))) })).filter(
    (g) => g.rows.length > 0,
  );
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
