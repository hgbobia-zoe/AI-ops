// Post-Event Customer Experience — deterministic funnel + metrics. RULES CALCULATE. Every percentage
// carries its absolute numerator and denominator; a percentage over an empty denominator is null (the UI
// renders "Unavailable", never a fabricated number). The core distinctions are kept separate: completed
// events != follow-up initiated != customer reached != experience confirmed != positive != review
// requested != review received.

import { getDb } from "@/lib/db/index";
import { todayInOpsTz } from "@/lib/dates";
import { type PostEventMetrics, type FunnelStep, type Bottleneck, type Disposition, rate } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface MetricsQuery {
  days?: number | null; // 7 | 30 | 90 | null(all-time)
  start?: string | null; // custom range (overrides days)
  end?: string | null;
}

interface Agg {
  bookingId: string;
  state: string;
  disposition: Disposition | null;
  contactCount: number;
  responded: number;
  hasRequest: boolean;
  hasReceived: boolean;
  hasIssue: boolean;
}

const REACHED_OR_LATER = new Set(["customer_responded", "experience_confirmed", "review_requested", "review_completed"]);
const CONFIRMED_OR_LATER = new Set(["experience_confirmed", "review_requested", "review_completed"]);

export function computeMetrics(q: MetricsQuery = {}): PostEventMetrics {
  const today = todayInOpsTz();
  let start: string | null;
  let end: string;
  let periodDays: number | null;
  if (q.start || q.end) {
    start = q.start ?? null;
    end = q.end ?? today;
    periodDays = null;
  } else if (q.days == null) {
    start = null;
    end = today;
    periodDays = null;
  } else {
    periodDays = q.days;
    start = addDays(today, -q.days);
    end = today;
  }

  // Projects whose EVENT date falls in the period (fallback to the pickup date when undated). These are
  // the completed events that are the funnel denominator.
  const db = getDb();
  const anchor = "COALESCE(event_date, substr(pickup_at,1,10))";
  const where: string[] = [];
  const params: any[] = [];
  if (start) {
    where.push(`${anchor} >= ?`);
    params.push(start);
  }
  where.push(`${anchor} <= ?`);
  params.push(end);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const projects = db.prepare(`SELECT booking_id, state, disposition FROM postevent_projects ${clause}`).all(...params) as any[];

  const ids = projects.map((p) => String(p.booking_id));
  const contactMap = new Map<string, { count: number; responded: number }>();
  const requestSet = new Set<string>();
  const receivedSet = new Set<string>();
  const issueSet = new Set<string>();
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    for (const r of db
      .prepare(
        `SELECT booking_id, COUNT(*) AS n,
                SUM(CASE WHEN direction='inbound' OR outcome IN ('customer_responded','requested_callback','positive','issue_reported') THEN 1 ELSE 0 END) AS responded
           FROM postevent_contacts WHERE booking_id IN (${ph}) GROUP BY booking_id`,
      )
      .all(...ids) as any[])
      contactMap.set(String(r.booking_id), { count: Number(r.n ?? 0), responded: Number(r.responded ?? 0) });
    for (const r of db.prepare(`SELECT DISTINCT booking_id, kind FROM postevent_reviews WHERE booking_id IN (${ph})`).all(...ids) as any[]) {
      if (r.kind === "requested") requestSet.add(String(r.booking_id));
      else if (r.kind === "received") receivedSet.add(String(r.booking_id));
    }
    for (const r of db.prepare(`SELECT DISTINCT booking_id FROM postevent_issues WHERE booking_id IN (${ph})`).all(...ids) as any[]) issueSet.add(String(r.booking_id));
  }

  const aggs: Agg[] = projects.map((p) => {
    const id = String(p.booking_id);
    const c = contactMap.get(id) ?? { count: 0, responded: 0 };
    return {
      bookingId: id,
      state: String(p.state),
      disposition: (p.disposition as Disposition) ?? null,
      contactCount: c.count,
      responded: c.responded,
      hasRequest: requestSet.has(id),
      hasReceived: receivedSet.has(id),
      hasIssue: issueSet.has(id),
    };
  });

  // Per-project funnel booleans (deterministic, facts + human-set state/disposition).
  let completed = 0,
    followUpInitiated = 0,
    customerReached = 0,
    experienceConfirmed = 0,
    positiveExperiences = 0,
    reviewRequestsSent = 0,
    reviewsReceived = 0,
    issues = 0;
  for (const a of aggs) {
    completed++;
    const initiated = a.contactCount > 0 || a.state !== "needs_follow_up";
    const reached = a.responded > 0 || REACHED_OR_LATER.has(a.state) || a.disposition != null;
    const confirmed = a.disposition != null || CONFIRMED_OR_LATER.has(a.state);
    const positive = a.disposition === "positive" || a.disposition === "positive_minor";
    if (initiated) followUpInitiated++;
    if (reached) customerReached++;
    if (confirmed) experienceConfirmed++;
    if (positive) positiveExperiences++;
    if (a.hasRequest) reviewRequestsSent++;
    if (a.hasReceived) reviewsReceived++;
    if (a.hasIssue) issues++;
  }

  const funnel: FunnelStep[] = [
    { key: "completed", label: "Completed Events", count: completed },
    { key: "initiated", label: "Follow-Up Initiated", count: followUpInitiated },
    { key: "reached", label: "Customer Reached", count: customerReached },
    { key: "confirmed", label: "Experience Confirmed", count: experienceConfirmed },
    { key: "positive", label: "Positive Experiences", count: positiveExperiences },
    { key: "requested", label: "Review Requests Sent", count: reviewRequestsSent },
    { key: "received", label: "Reviews Received", count: reviewsReceived },
  ];

  return {
    periodDays,
    start,
    end,
    funnel,
    counts: { completed, followUpInitiated, customerReached, experienceConfirmed, positiveExperiences, reviewRequestsSent, reviewsReceived, issues },
    rates: {
      followUpCoverage: rate(followUpInitiated, completed),
      contactRate: rate(customerReached, followUpInitiated),
      experienceConfirmationRate: rate(experienceConfirmed, customerReached),
      issueRate: rate(issues, experienceConfirmed),
      reviewRequestRate: rate(reviewRequestsSent, positiveExperiences),
      reviewConversion: rate(reviewsReceived, reviewRequestsSent),
      overallReviewRate: rate(reviewsReceived, completed),
    },
    bottleneck: biggestBottleneck({ completed, followUpInitiated, customerReached, experienceConfirmed, positiveExperiences, reviewRequestsSent, reviewsReceived }),
  };
}

/** The single biggest factual drop-off in the funnel — "where are we losing customers?" — chosen
 *  deterministically by the largest stuck count. Ties resolve to the earliest funnel stage. */
export function biggestBottleneck(c: {
  completed: number;
  followUpInitiated: number;
  customerReached: number;
  experienceConfirmed: number;
  positiveExperiences: number;
  reviewRequestsSent: number;
  reviewsReceived: number;
}): Bottleneck | null {
  const candidates: { stageKey: string; stuck: number; total: number; phrase: string; eligibleDen: boolean }[] = [
    { stageKey: "initiated", stuck: c.completed - c.followUpInitiated, total: c.completed, phrase: "have had no follow-up started yet", eligibleDen: true },
    { stageKey: "reached", stuck: c.completed - c.customerReached, total: c.completed, phrase: "have no successful contact yet", eligibleDen: true },
    { stageKey: "confirmed", stuck: c.customerReached - c.experienceConfirmed, total: c.customerReached, phrase: "were reached but their experience is not yet confirmed", eligibleDen: false },
    { stageKey: "requested", stuck: c.positiveExperiences - c.reviewRequestsSent, total: c.positiveExperiences, phrase: "had a positive experience but no review request has been sent", eligibleDen: false },
    { stageKey: "received", stuck: c.reviewRequestsSent - c.reviewsReceived, total: c.reviewRequestsSent, phrase: "were asked for a review but none has come in yet", eligibleDen: false },
  ].filter((x) => x.stuck > 0 && x.total > 0);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.stuck - a.stuck); // largest stuck wins (stable: input already in funnel order)
  const w = candidates[0];
  const noun = w.eligibleDen ? "eligible projects" : "projects";
  return { stageKey: w.stageKey, stuck: w.stuck, total: w.total, headline: `${w.stuck} of ${w.total} ${noun} ${w.phrase}.` };
}

// ── Employee activity (early cut; full accountability reporting is Phase 2) ──────────────────────────
// The data model already supports the full report: transitions carry actor + timestamp, contacts carry
// the employee, reviews carry the requester. This is a real, deterministic snapshot over those facts.
export interface EmployeeActivityRow {
  employee: string;
  contactsLogged: number;
  reviewRequests: number;
  moves: number;
}
export function employeeActivity(): EmployeeActivityRow[] {
  const db = getDb();
  const agg = new Map<string, EmployeeActivityRow>();
  const get = (name: string): EmployeeActivityRow => {
    let r = agg.get(name);
    if (!r) {
      r = { employee: name, contactsLogged: 0, reviewRequests: 0, moves: 0 };
      agg.set(name, r);
    }
    return r;
  };
  for (const r of db.prepare("SELECT employee, COUNT(*) AS n FROM postevent_contacts WHERE source='manual' AND employee IS NOT NULL AND employee != '' GROUP BY employee").all() as any[])
    get(String(r.employee)).contactsLogged = Number(r.n ?? 0);
  for (const r of db.prepare("SELECT employee, COUNT(*) AS n FROM postevent_reviews WHERE kind='requested' AND employee IS NOT NULL AND employee != '' GROUP BY employee").all() as any[])
    get(String(r.employee)).reviewRequests = Number(r.n ?? 0);
  for (const r of db.prepare("SELECT actor, COUNT(*) AS n FROM postevent_transitions WHERE actor IS NOT NULL AND actor != '' AND actor != 'system' GROUP BY actor").all() as any[])
    get(String(r.actor)).moves = Number(r.n ?? 0);
  return [...agg.values()].sort((a, b) => b.contactsLogged + b.reviewRequests + b.moves - (a.contactsLogged + a.reviewRequests + a.moves));
}

// ── Closure-reason breakdown (for the Closure Reasons blade) ─────────────────────────────────────────
export interface ClosureBreakdownRow {
  reason: string;
  count: number;
}
export function closureBreakdown(): { total: number; rows: ClosureBreakdownRow[] } {
  const rows = getDb()
    .prepare("SELECT closure_reason AS reason, COUNT(*) AS n FROM postevent_projects WHERE state='closed' AND closure_reason IS NOT NULL GROUP BY closure_reason ORDER BY n DESC")
    .all() as any[];
  const out = rows.map((r) => ({ reason: String(r.reason), count: Number(r.n ?? 0) }));
  return { total: out.reduce((s, r) => s + r.count, 0), rows: out };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
