// Delivery on-time tracking — PURE, deterministic, unit-tested (onTime.test.ts).
//
// Three questions the Oct 30 to Nov 1 2026 review could not answer automatically:
//   1. Did the truck reach the customer on time? Scored against the CUSTOMER window start (Goodshuffle
//      project logistics_start_from_time, or a per-waypoint required-arrival window when dispatch set one),
//      NOT the dispatcher's planned arrival (waypoint scheduledArrivalTime). Those two differ: Palmer's
//      window opened 9:00 but the route planned the truck for 11:05.
//   2. Do the app "arrived" tap and the GPS visit agree? (Wiener: tap 11:09 AM, GPS first sees the truck
//      at 3:19 PM.)
//   3. Does the planned sequence stack a stop far past its window behind a long earlier stop? (Montealegre
//      planned 1h 55m on site, then McGahn, same 9:00 window, planned 12:35.)
//
// No DB, no clock, no network. Callers pass ISO strings; every function tolerates missing data and says so
// (a missing window is "no window", never a fabricated on-time).

import { formatClockTime, opsLocalInputToIso } from "@/lib/dates";
import type { Stop } from "@/lib/types";

/** Minutes after the window start that still count as on time. */
export const ON_TIME_GRACE_MIN = 15;
/** App "arrived" tap and GPS arrival further apart than this are flagged for review. */
export const ARRIVAL_MISMATCH_MIN = 60;
/** A planned arrival more than this past the window start raises a pre-day sequencing warning. */
export const STACK_WARN_MIN = 60;
/** On-site duration used when Goodshuffle has no planned time on site (waypoint scheduledLoiterMinutes).
 *  A conservative typical value by stop type; the warning text says when a default was used. */
export const DEFAULT_ON_SITE_MIN: Record<"delivery" | "pickup", number> = { delivery: 60, pickup: 45 };
/** Drive time between stops used when Goodshuffle has no transit estimate for the leg. */
export const DEFAULT_TRANSIT_MIN = 30;

const MIN = 60_000;

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// ── Window parsing ────────────────────────────────────────────────────────────────────────────────────

// US zone abbreviations Goodshuffle appends ("9:00 AM EDT"). Minutes EAST of UTC (negative = west).
const ZONE_OFFSET_MIN: Record<string, number> = {
  EDT: -240, EST: -300, CDT: -300, CST: -360, MDT: -360, MST: -420, PDT: -420, PST: -480,
};

/**
 * A Goodshuffle logistics time on a calendar day → ISO instant. Goodshuffle's searchProjects returns
 * `logistics_start_date: "Oct 31, 2026"` + `logistics_start_from_time: "9:00 AM EDT"` (or "TBD").
 * Accepts "9:00 AM EDT", "9 AM", "09:00", "13:30", or a full ISO datetime. An explicit zone abbreviation
 * is honoured; otherwise the wall time is read in the operating timezone. "TBD"/blank/garbage → null.
 */
export function parseGsWindowTime(eventYmd: string | null | undefined, timeStr: string | null | undefined): string | null {
  const raw = (timeStr ?? "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const t = ms(raw);
    return t == null ? null : new Date(t).toISOString();
  }
  if (!eventYmd || !/^\d{4}-\d{2}-\d{2}$/.test(eventYmd)) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM|A\.M\.|P\.M\.)?\s*([A-Z]{2,4})?$/i.exec(raw);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toUpperCase().replace(/\./g, "");
  if (mi > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === "AM" && h === 12) h = 0;
    if (ampm === "PM" && h !== 12) h += 12;
  } else if (h > 23 || !m[2]) {
    return null; // a bare "9" with no AM/PM is ambiguous
  }
  const zone = m[4]?.toUpperCase();
  const [y, mo, d] = eventYmd.split("-").map(Number);
  if (zone && zone in ZONE_OFFSET_MIN) {
    return new Date(Date.UTC(y, mo - 1, d, h, mi) - ZONE_OFFSET_MIN[zone] * MIN).toISOString();
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return opsLocalInputToIso(`${eventYmd}T${pad(h)}:${pad(mi)}`);
}

/**
 * The customer window start for a stop, from its Goodshuffle project (bookings feed). The project's
 * logistics start is the DELIVERY window, so it applies only to a delivery stop on that same day; a
 * pickup (or a stop on another day) gets null rather than a wrong window.
 */
export function bookingWindowForStop(input: {
  kind?: "delivery" | "pickup" | null;
  routeDate: string;
  eventDate: string | null | undefined;
  timeStr: string | null | undefined;
}): string | null {
  if (input.kind === "pickup") return null;
  if (!input.eventDate || input.eventDate !== input.routeDate) return null;
  return parseGsWindowTime(input.eventDate, input.timeStr);
}

// ── On-time scoring ───────────────────────────────────────────────────────────────────────────────────

export type OnTimeStatus = "on_time" | "late" | "no_window" | "not_arrived";

export interface OnTimeResult {
  status: OnTimeStatus;
  /** The arrival used for the score (GPS when present, else the app tap). */
  arrivalIso?: string;
  source?: "gps" | "app";
  /** Arrival minus window start, in whole minutes (negative = early). */
  minutesLate?: number;
}

/** Score one stop. On time = arrived at or before window start + grace. GPS arrival wins over the tap. */
export function scoreOnTime(input: {
  windowStart?: string | null;
  appArrivedAt?: string | null;
  gpsArrivedAt?: string | null;
  graceMin?: number;
}): OnTimeResult {
  const grace = input.graceMin ?? ON_TIME_GRACE_MIN;
  const gps = ms(input.gpsArrivedAt);
  const app = ms(input.appArrivedAt);
  const arrival = gps ?? app;
  const source: "gps" | "app" | undefined = gps != null ? "gps" : app != null ? "app" : undefined;
  const win = ms(input.windowStart);
  if (win == null) {
    return arrival == null ? { status: "no_window" } : { status: "no_window", arrivalIso: new Date(arrival).toISOString(), source };
  }
  if (arrival == null) return { status: "not_arrived" };
  const minutesLate = Math.round((arrival - win) / MIN);
  return {
    status: minutesLate <= grace ? "on_time" : "late",
    arrivalIso: new Date(arrival).toISOString(),
    source,
    minutesLate,
  };
}

/** Board badge for an on-time result: a short label and a tone. Null when there is nothing to score yet. */
export function onTimeBadge(r: OnTimeResult): { label: string; tone: "positive" | "critical" | "neutral" } | null {
  if (r.status === "on_time") return { label: "On time", tone: "positive" };
  if (r.status === "late") return { label: `Late ${formatDuration(r.minutesLate ?? 0)}`, tone: "critical" };
  if (r.status === "no_window" && r.arrivalIso) return { label: "No window to score", tone: "neutral" };
  return null;
}

// ── App tap vs GPS ────────────────────────────────────────────────────────────────────────────────────

export interface ArrivalMismatch {
  /** GPS arrival minus app tap, whole minutes (positive = GPS saw the truck later than the tap). */
  deltaMin: number;
  gpsLater: boolean;
}

/** Flag when the app "arrived" tap and the GPS arrival differ by more than the threshold. */
export function arrivalMismatch(
  appArrivedAt: string | null | undefined,
  gpsArrivedAt: string | null | undefined,
  thresholdMin: number = ARRIVAL_MISMATCH_MIN,
): ArrivalMismatch | null {
  const app = ms(appArrivedAt);
  const gps = ms(gpsArrivedAt);
  if (app == null || gps == null) return null;
  const deltaMin = Math.round((gps - app) / MIN);
  if (Math.abs(deltaMin) <= thresholdMin) return null;
  return { deltaMin, gpsLater: deltaMin > 0 };
}

// ── Pre-day sequencing (stacking) ─────────────────────────────────────────────────────────────────────

export interface PlanStop {
  stopId: string;
  sequence: number;
  custName: string;
  kind?: "delivery" | "pickup";
  /** Customer window start (ISO). */
  windowStart?: string | null;
  /** Dispatcher's planned arrival (Goodshuffle waypoint scheduledArrivalTime, ISO). */
  plannedArrival?: string | null;
  /** Planned minutes on site (Goodshuffle scheduledLoiterMinutes). */
  plannedOnSiteMin?: number | null;
  /** Planned drive minutes from the previous waypoint (Goodshuffle transitMinutes.left). */
  plannedTransitMin?: number | null;
}

/** A route's stops in the shape the sequencing check wants. The whole planned order is passed (finished
 *  stops included) so the chain of on-site time stays right. */
export function routePlanStops(route: { stops: Stop[] }): PlanStop[] {
  return route.stops.map((s) => ({
    stopId: s.stopId,
    sequence: s.sequence,
    custName: s.custName,
    kind: s.kind,
    windowStart: s.windowStart ?? null,
    plannedArrival: s.plannedWindow || s.eta || null,
    plannedOnSiteMin: s.plannedOnSiteMin ?? null,
    plannedTransitMin: s.plannedTransitMin ?? null,
  }));
}

export interface PlannedArrival {
  stopId: string;
  estArrivalMs: number | null;
  onSiteMin: number;
  onSiteDefaulted: boolean;
}

/**
 * Walk the planned sequence: each stop's estimated arrival is the later of its own planned arrival and
 * (previous estimated arrival + previous time on site + drive time). The first stop starts at its planned
 * arrival (or its window start when unplanned). Missing durations use the named defaults above.
 */
export function estimateArrivals(stops: PlanStop[]): PlannedArrival[] {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const out: PlannedArrival[] = [];
  let departMs: number | null = null;
  for (const s of ordered) {
    const kind = s.kind === "pickup" ? "pickup" : "delivery";
    const onSiteDefaulted = !(typeof s.plannedOnSiteMin === "number" && s.plannedOnSiteMin > 0);
    const onSiteMin = onSiteDefaulted ? DEFAULT_ON_SITE_MIN[kind] : (s.plannedOnSiteMin as number);
    const planned = ms(s.plannedArrival);
    let est: number | null;
    if (departMs == null) {
      est = planned ?? ms(s.windowStart);
    } else {
      const transit = typeof s.plannedTransitMin === "number" && s.plannedTransitMin >= 0 ? s.plannedTransitMin : DEFAULT_TRANSIT_MIN;
      const chained: number = departMs + transit * MIN;
      est = planned != null ? Math.max(planned, chained) : chained;
    }
    out.push({ stopId: s.stopId, estArrivalMs: est, onSiteMin, onSiteDefaulted });
    departMs = est == null ? null : est + onSiteMin * MIN;
  }
  return out;
}

export interface StackWarning {
  stopId: string;
  custName: string;
  windowStart: string;
  estArrival: string;
  minutesPastWindow: number;
  /** "stacked" = behind an earlier stop on the route; "planned_late" = the first stop is itself planned late. */
  cause: "stacked" | "planned_late";
  prevStopId?: string;
  prevCustName?: string;
  prevOnSiteMin?: number;
  prevOnSiteDefaulted?: boolean;
  /** Short plain sentence for the board and Slack. */
  message: string;
}

/** "3h 35m", "45m", "2h". */
export function formatDuration(totalMin: number): string {
  const m = Math.max(0, Math.round(totalMin));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

/** Stops whose estimated arrival lands more than `thresholdMin` past their window start. */
export function stackingWarnings(stops: PlanStop[], thresholdMin: number = STACK_WARN_MIN): StackWarning[] {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const est = estimateArrivals(ordered);
  const out: StackWarning[] = [];
  ordered.forEach((s, i) => {
    const win = ms(s.windowStart);
    const arr = est[i].estArrivalMs;
    if (win == null || arr == null) return;
    const past = Math.round((arr - win) / MIN);
    if (past <= thresholdMin) return;
    const windowStart = new Date(win).toISOString();
    const estArrival = new Date(arr).toISOString();
    const head = `${s.custName || "This stop"} is planned for ${formatClockTime(estArrival)}, ${formatDuration(past)} after the window opens at ${formatClockTime(windowStart)}.`;
    if (i === 0) {
      out.push({ stopId: s.stopId, custName: s.custName, windowStart, estArrival, minutesPastWindow: past, cause: "planned_late", message: head });
      return;
    }
    const prev = ordered[i - 1];
    const pe = est[i - 1];
    const dur = pe.onSiteDefaulted
      ? `${formatDuration(pe.onSiteMin)} on site (default, no duration in Goodshuffle)`
      : `${formatDuration(pe.onSiteMin)} on site`;
    out.push({
      stopId: s.stopId,
      custName: s.custName,
      windowStart,
      estArrival,
      minutesPastWindow: past,
      cause: "stacked",
      prevStopId: prev.stopId,
      prevCustName: prev.custName,
      prevOnSiteMin: pe.onSiteMin,
      prevOnSiteDefaulted: pe.onSiteDefaulted,
      message: `${head} It follows ${prev.custName || "the stop before it"}, planned for ${dur}.`,
    });
  });
  return out;
}

// ── Closeout resolutions for stops left incomplete ────────────────────────────────────────────────────

/** What the closer chose for one incomplete stop. */
export interface CloseResolutionInput {
  stopId: string;
  action: "completed" | "reason";
  reason?: string;
}

/** Minimum reason length (a real sentence, not a single keystroke). */
export const MIN_CLOSE_REASON_LEN = 3;

/** Is this one resolution acceptable (mark completed, or a real reason)? */
export function isResolved(r: CloseResolutionInput | undefined): boolean {
  if (!r) return false;
  if (r.action === "completed") return true;
  return r.action === "reason" && (r.reason ?? "").trim().length >= MIN_CLOSE_REASON_LEN;
}

/** Which incomplete stops still lack a resolution. Empty = ready to close. */
export function unresolvedStops(incompleteStopIds: string[], resolutions: CloseResolutionInput[] | undefined): string[] {
  const byId = new Map((resolutions ?? []).map((r) => [r.stopId, r]));
  return incompleteStopIds.filter((id) => !isResolved(byId.get(id)));
}
