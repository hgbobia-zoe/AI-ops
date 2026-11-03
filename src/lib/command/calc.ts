// Command Center — pure aggregation helpers (no I/O), so the dashboard's derived numbers are unit-
// tested rather than assembled inline in the page. Everything here is deterministic arithmetic over
// data another layer already fetched. RULES CALCULATE.

import { shiftYmd } from "@/lib/dates";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface OutlookDay {
  date: string;
  dow: string; // "Mon"
  isToday: boolean;
  jobs: number; // booked events that day (lost/cancelled already excluded upstream)
  revenue: number | null; // committed (signed) $ that day; null when nothing priced/signed
  verdict: string | null; // capacity verdict for the day, if computed
  driversScheduled: number | null; // crew ratio "X" — drivers scheduled that day
  driversNeeded: number | null; // crew ratio "Y" — drivers needed (peak concurrent routes)
}

/** Build the next `days` days from `today`, folding in booked events, capacity verdicts and (when
 *  supplied) the per-day driver ratio for the capacity strip. */
export function sevenDayOutlook(
  today: string,
  bookings: { date: string; revenue?: number | null; signed?: boolean }[],
  capacityByDate: Map<string, string>,
  days = 7,
  crewByDate?: Map<string, { scheduled: number | null; needed: number | null }>,
): OutlookDay[] {
  const out: OutlookDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = shiftYmd(today, i);
    const dow = DOW[new Date(`${date}T00:00:00Z`).getUTCDay()];
    let jobs = 0;
    let revenue: number | null = null;
    for (const b of bookings) {
      if (b.date !== date) continue;
      jobs++;
      if (b.signed && typeof b.revenue === "number") revenue = (revenue ?? 0) + b.revenue;
    }
    const crew = crewByDate?.get(date);
    out.push({
      date, dow, isToday: i === 0, jobs, revenue,
      verdict: capacityByDate.get(date) ?? null,
      driversScheduled: crew?.scheduled ?? null,
      driversNeeded: crew?.needed ?? null,
    });
  }
  return out;
}

export type OpStatus = "quiet" | "normal" | "busy" | "at-risk";

/** A single at-a-glance status for the day, from job load + whether anything needs attention. Purely
 *  a display rollup — the attention feed remains the source of truth for specifics. */
export function dayStatus(jobsToday: number, criticalOrHigh: number, capacityConstrained: boolean): OpStatus {
  if (criticalOrHigh > 0 || capacityConstrained) return "at-risk";
  if (jobsToday === 0) return "quiet";
  if (jobsToday >= 12) return "busy";
  return "normal";
}

/** Percent of target, clamped to a sensible display range. null when target unknown. */
export function pctOfTarget(actual: number | null, target: number | null): number | null {
  if (actual == null || target == null || target <= 0) return null;
  return Math.round((actual / target) * 100);
}

// ── Revenue path-to-target ───────────────────────────────────────────────────
// Answers "are we making our number?" deterministically. NOTE: we DON'T do a linear run-rate
// "pace" projection — event-rental revenue is booked ahead (most of a month's revenue is signed
// weeks before), so run-rate would mislead. Instead we frame it as target COVERAGE: committed vs
// target, and whether the open quotes for the period can still close the gap.
export type RevenueStatus = "met" | "likely" | "at-risk" | "no-target" | "no-data";

export interface RevenueOutlook {
  periodLabel: string;
  target: number | null;
  committed: number | null; // signed revenue for events IN the period
  pipeline: number | null; // open (unsigned) quotes for events in the period — could still close
  pctOfTarget: number | null;
  pctElapsed: number; // 0–100, share of the calendar period elapsed (context, not a run-rate)
  remaining: number | null; // target − committed, floored at 0
  ceiling: number | null; // committed + pipeline = best case if every open quote closes
  gapAfterPipeline: number | null; // > 0 ⇒ short even if all quotes close
  status: RevenueStatus;
}

// ── Command Center cockpit helpers (pure, for the redesigned homepage) ─────────
// Deterministic interpretation of statuses ALREADY computed elsewhere. These map/label existing facts;
// they never invent a number. RULES CALCULATE, the UI renders.

/** One-line situation verdict for the "Today's Situation" header. A label mapping over the revenue
 *  status + whether operations have a critical/high issue or a near-term capacity constraint. Mirrors the
 *  intent of revenueSentence: states a conclusion from facts, fabricates nothing. */
export function situationHeadline(inp: {
  revStatus: RevenueStatus;
  showMoney: boolean;
  criticalOrHigh: number;
  capacityConstrainedSoon: boolean;
}): string {
  const opsTrouble = inp.criticalOrHigh > 0 || inp.capacityConstrainedSoon;
  const revKnown = inp.showMoney && (inp.revStatus === "met" || inp.revStatus === "likely" || inp.revStatus === "at-risk");
  if (!revKnown) return opsTrouble ? "Operations need attention." : "Operations are on track.";
  const revHealthy = inp.revStatus === "met" || inp.revStatus === "likely";
  if (revHealthy && opsTrouble) return "Revenue is healthy. Operations are the constraint.";
  if (revHealthy && !opsTrouble) return "Revenue is on track and operations are clear.";
  if (!revHealthy && opsTrouble) return "Revenue and operations both need attention.";
  return "Operations are steady. Revenue is behind target.";
}

// The capacity levels the cockpit's 7-day strip renders. Only the levels the underlying data actually
// supports — we do NOT invent a "CRITICAL" verdict the capacity engine never emits.
export type CapacityLevel = "NORMAL" | "TIGHT" | "CONSTRAINED" | "UNVERIFIED";

/** Map a raw capacity verdict (AVAILABLE | TIGHT | CONSTRAINED | UNVERIFIED | null) to a display level. */
export function capacityLevel(verdict: string | null | undefined): CapacityLevel {
  if (verdict === "TIGHT") return "TIGHT";
  if (verdict === "CONSTRAINED") return "CONSTRAINED";
  if (verdict === "UNVERIFIED") return "UNVERIFIED";
  return "NORMAL"; // AVAILABLE or unknown-but-no-pressure
}

/** How many times the open pipeline covers the remaining target gap (one decimal), or null when the gap
 *  is already closed / unknown. Drives the "open pipeline is X× the remaining target gap" insight. */
export function pipelineCoverageMultiple(openValue: number | null, remainingGap: number | null): number | null {
  if (openValue == null || remainingGap == null || remainingGap <= 0) return null;
  return Math.round((openValue / remainingGap) * 10) / 10;
}

export function computeRevenueOutlook(inp: {
  periodLabel: string;
  target: number | null;
  committed: number | null;
  pipeline: number | null;
  pctElapsed: number;
}): RevenueOutlook {
  const { target, committed, pipeline } = inp;
  const pctT = pctOfTarget(committed, target);
  const remaining = target != null && committed != null ? Math.max(0, target - committed) : null;
  const ceiling = committed != null || pipeline != null ? (committed ?? 0) + (pipeline ?? 0) : null;
  const gapAfter = target != null && ceiling != null ? Math.round(target - ceiling) : null;

  let status: RevenueStatus;
  if (target == null) status = "no-target";
  else if (committed == null) status = "no-data";
  else if (committed >= target) status = "met";
  else if ((ceiling ?? 0) >= target) status = "likely"; // the gap can still be closed from open quotes
  else status = "at-risk"; // short even if every open quote closes

  return {
    periodLabel: inp.periodLabel,
    target,
    committed,
    pipeline,
    pctOfTarget: pctT,
    pctElapsed: Math.max(0, Math.min(100, Math.round(inp.pctElapsed))),
    remaining,
    ceiling,
    gapAfterPipeline: gapAfter != null && gapAfter > 0 ? gapAfter : null,
    status,
  };
}

/** Exceptions that belong to TODAY's operations. The exceptions table keeps every unresolved row ever
 *  logged, so counting all of them made one old, never-closed exception mark today as "at risk". An
 *  exception tied to a stop counts only when that stop is on today's routes; one with no stop counts
 *  only when it was logged today (ops time zone, via `ymdOf`). */
export function todaysExceptions<T extends { stopId: string | null; ts: string }>(
  exceptions: T[],
  todayStopIds: Set<string>,
  today: string,
  ymdOf: (iso: string) => string,
): T[] {
  return exceptions.filter((x) => {
    if (x.stopId) return todayStopIds.has(x.stopId);
    try {
      return ymdOf(x.ts) === today;
    } catch {
      return false;
    }
  });
}

/** A session marked "running" counts as live only with recent activity. Every timeline event touches
 *  updated_at, so a running session silent for longer than this has most likely stalled. */
export const AI_LIVE_FRESH_MIN = 30;

export type AiActivityState = "live" | "idle" | "approval" | "other";

/** How the dashboard should present one AI session: running + recent activity = live; running but
 *  silent = idle (stalled, never counted as live); awaiting approval = waiting on a person (real work,
 *  no staleness rule). Everything else (paused, done, failed, cancelled) keeps its own status. */
export function aiActivityState(s: { status: string; updatedAt: string }, nowMs: number, freshMin = AI_LIVE_FRESH_MIN): AiActivityState {
  if (s.status === "awaiting_approval") return "approval";
  if (s.status !== "running") return "other";
  const t = Date.parse(s.updatedAt);
  if (!Number.isFinite(t)) return "idle";
  return nowMs - t <= freshMin * 60_000 ? "live" : "idle";
}

/** Count of sessions that are live by the rule above. */
export function liveAiCount(sessions: { status: string; updatedAt: string }[], nowMs: number, freshMin = AI_LIVE_FRESH_MIN): number {
  return sessions.filter((s) => aiActivityState(s, nowMs, freshMin) === "live").length;
}

/** Goodshuffle data older than this is flagged on the dashboard (the office Auto-Pull runs daily). */
export const GS_DATA_STALE_H = 24;

export interface DataFreshness {
  at: string | null; // ISO of the last successful bookings pull, null if never
  ageLabel: string; // "12m ago", "5h ago", "3d ago", "never"
  stale: boolean; // older than GS_DATA_STALE_H, or never pulled
}

/** How fresh the Goodshuffle numbers on the dashboard are. Every booking, quote and revenue figure
 *  comes from the last Auto-Pull, so the page states its age instead of looking live. */
export function dataFreshness(at: string | null | undefined, nowMs: number, staleH = GS_DATA_STALE_H): DataFreshness {
  const t = at ? Date.parse(at) : NaN;
  if (!at || !Number.isFinite(t)) return { at: null, ageLabel: "never", stale: true };
  const m = Math.max(0, Math.round((nowMs - t) / 60_000));
  const ageLabel = m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  return { at, ageLabel, stale: nowMs - t > staleH * 3_600_000 };
}
