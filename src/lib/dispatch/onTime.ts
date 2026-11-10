// Delivery on-time tracking — PURE, deterministic, unit-tested (onTime.test.ts).
//
// Three questions the Oct 30 to Nov 1 2026 review could not answer automatically:
//   1. Did the truck reach the customer on time? Scored against the CUSTOMER window, NOT the dispatcher's
//      planned arrival (waypoint scheduledArrivalTime). Goodshuffle windows are RANGES ("Saturday, 10/31
//      [9:00 AM - 8:00 PM]" on the project timeline, initProjectTimeline): on time = arrived by the window
//      END plus grace; before the START is early (shown, not a failure). When only the start is known
//      (searchProjects logistics_start_from_time), a late arrival is reported as "window end unknown",
//      never as late. Pickups are scored from the PICK_UP window. A "PIN POINT EXACT TIME" window is a
//      paid exact time: tagged, and a miss is the most severe late.
//   2. Do the app "arrived" tap and the GPS visit agree? (Wiener: tap 11:09 AM, GPS first sees the truck
//      at 3:19 PM.)
//   3. Does the planned sequence stack a stop far past its window behind a long earlier stop? (Montealegre
//      planned 1h 55m on site, then McGahn, same 9:00 window, planned 12:35.)
//
// No DB, no clock, no network. Callers pass ISO strings; every function tolerates missing data and says so
// (a missing window is "no window", never a fabricated on-time).

import { formatClockTime, opsLocalInputToIso } from "@/lib/dates";
import type { Stop } from "@/lib/types";

/** Minutes after the window END that still count as on time (after the start, when the end is unknown). */
export const ON_TIME_GRACE_MIN = 15;
/** App "arrived" tap and GPS arrival further apart than this are flagged for review. */
export const ARRIVAL_MISMATCH_MIN = 60;
/** When only the window START is known: a planned arrival more than this past it raises a pre-day
 *  sequencing warning. */
export const STACK_WARN_MIN = 60;
/** When the window END is known: a planned arrival more than this past the end raises the warning (the
 *  same grace the score uses, so the warning means "this plan would score late"). */
export const STACK_WARN_PAST_END_MIN = ON_TIME_GRACE_MIN;
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

// ── Project timeline windows (initProjectTimeline) ────────────────────────────────────────────────────
//
// GET /app/vendorTransaction/initProjectTimeline?transactionID=<id> returns events[]; the logistics ones
// (type "logisticsDelivery") carry eventTimeLineMarker "DROP_OFF" | "PICK_UP", the delivery line's name,
// and a dateLabel. Real labels (verified live 2026-11-10):
//   "Saturday, 10/31 [9:00 AM - 8:00 PM]"   a range
//   "Saturday, 10/31 [10:15 AM]"            a single time (start = end)
// The browser pulls send these raw ({ marker, name, dateLabel }); parsing lives here, once, unit-tested.

export type WindowKind = "drop_off" | "pick_up";

/** A logisticsDelivery timeline entry as the pull sends it. */
export interface RawTimelineEvent {
  marker?: string | null;
  name?: string | null;
  dateLabel?: string | null;
}

/** One parsed customer window from the project timeline. */
export interface TimelineWindow {
  kind: WindowKind;
  /** Calendar day, YYYY-MM-DD. */
  date: string;
  /** Wall times as Goodshuffle wrote them ("9:00 AM"); a single time has end = start. */
  startTime: string;
  endTime: string;
  startIso: string;
  endIso: string;
  /** A paid "PIN POINT EXACT TIME" window. */
  pinPoint: boolean;
  /** The delivery line name ("Delivery fee", "PIN POINT EXACT TIME"). */
  name: string;
}

/** Names that mark a paid exact-time window. */
export const PIN_POINT_RE = /PIN\s*POINT/i;

/** The year for a month/day that has none ("10/31"): the one closest to the reference day. Handles a
 *  pickup in early January for a late December delivery. */
function inferYear(month: number, day: number, refYmd: string): number | null {
  const ref = /^(\d{4})-(\d{2})-(\d{2})$/.exec(refYmd);
  if (!ref) return null;
  const ry = Number(ref[1]);
  const refMs = Date.UTC(ry, Number(ref[2]) - 1, Number(ref[3]));
  let best: number | null = null;
  let bestDist = Infinity;
  for (const y of [ry - 1, ry, ry + 1]) {
    const t = Date.UTC(y, month - 1, day);
    const dist = Math.abs(t - refMs);
    if (dist < bestDist) {
      best = y;
      bestDist = dist;
    }
  }
  return best;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Parse one timeline dateLabel. `refYmd` (the project's logistics date, or today) resolves the missing
 * year. Wall times are read in the operating timezone. A range that ends before it starts is taken to
 * run past midnight. Returns null for anything without a readable day and time (e.g. "TBD").
 */
export function parseTimelineDateLabel(
  label: string | null | undefined,
  refYmd: string,
): { date: string; startTime: string; endTime: string; startIso: string; endIso: string } | null {
  const raw = (label ?? "").trim();
  if (!raw) return null;
  const dm = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?/.exec(raw);
  const bm = /\[([^\]]*)\]/.exec(raw);
  if (!dm || !bm) return null;
  const month = Number(dm[1]);
  const day = Number(dm[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year: number | null;
  if (dm[3]) year = dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3]);
  else year = inferYear(month, day, refYmd);
  if (year == null) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1) return null; // 2/30 and the like
  const date = `${year}-${pad2(month)}-${pad2(day)}`;
  const parts = bm[1].split(/\s*(?:-|–|—|\bto\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const startTime = parts[0];
  const endTime = parts[1] ?? parts[0];
  const startIso = parseGsWindowTime(date, startTime);
  let endIso = parseGsWindowTime(date, endTime);
  if (!startIso || !endIso) return null;
  if (Date.parse(endIso) < Date.parse(startIso)) endIso = new Date(Date.parse(endIso) + 24 * 60 * MIN).toISOString();
  return { date, startTime, endTime, startIso, endIso };
}

/** Parse a project's logistics timeline entries into customer windows (unreadable entries are dropped). */
export function parseTimelineWindows(events: RawTimelineEvent[] | null | undefined, refYmd: string): TimelineWindow[] {
  const out: TimelineWindow[] = [];
  for (const e of events ?? []) {
    const marker = (e?.marker ?? "").toUpperCase();
    const kind: WindowKind | null = marker === "DROP_OFF" ? "drop_off" : marker === "PICK_UP" ? "pick_up" : null;
    if (!kind) continue;
    const p = parseTimelineDateLabel(e.dateLabel, refYmd);
    if (!p) continue;
    const name = (e.name ?? "").trim().slice(0, 120);
    out.push({ kind, ...p, pinPoint: PIN_POINT_RE.test(name), name });
  }
  return out;
}

/** The window a stop is held to when a project lists several for the same day and kind: a paid exact
 *  time first, then a real range over a single time (an add-on service like "Event Readiness Service
 *  [10:15 AM]"), then the earliest. */
export function pickTimelineWindow(windows: TimelineWindow[]): TimelineWindow | null {
  if (windows.length === 0) return null;
  const isRange = (w: TimelineWindow) => (Date.parse(w.endIso) > Date.parse(w.startIso) ? 1 : 0);
  return [...windows].sort(
    (a, b) =>
      Number(b.pinPoint) - Number(a.pinPoint) ||
      isRange(b) - isRange(a) ||
      Date.parse(a.startIso) - Date.parse(b.startIso),
  )[0];
}

/** A stop's resolved customer window. */
export interface StopWindow {
  windowStart: string;
  /** Undefined = only the start is known (searchProjects), so lateness cannot be claimed. */
  windowEnd?: string;
  pinPoint: boolean;
  /** The Goodshuffle delivery line the window came from, when it came from the timeline. */
  label?: string;
}

/**
 * The customer window for a stop from its Goodshuffle project: the timeline window of the matching kind
 * (DROP_OFF for a delivery, PICK_UP for a pickup) on the route's day; else, for a same-day delivery only,
 * the start-only searchProjects time. Null when neither applies (never a guessed window).
 */
export function resolveStopWindow(input: {
  kind?: "delivery" | "pickup" | null;
  routeDate: string;
  timeline?: TimelineWindow[] | null;
  eventDate?: string | null;
  timeStr?: string | null;
}): StopWindow | null {
  const want: WindowKind = input.kind === "pickup" ? "pick_up" : "drop_off";
  const tw = pickTimelineWindow((input.timeline ?? []).filter((w) => w.kind === want && w.date === input.routeDate));
  if (tw) return { windowStart: tw.startIso, windowEnd: tw.endIso, pinPoint: tw.pinPoint, label: tw.name || undefined };
  const start = bookingWindowForStop({ kind: input.kind, routeDate: input.routeDate, eventDate: input.eventDate, timeStr: input.timeStr });
  return start ? { windowStart: start, pinPoint: false } : null;
}

/** "9:00 AM to 8:00 PM", "10:15 AM", or "opens 9:00 AM, end unknown". No dashes (house style). */
export function formatWindow(windowStart: string | null | undefined, windowEnd: string | null | undefined): string {
  if (!windowStart) return "";
  const s = formatClockTime(windowStart);
  if (!windowEnd) return `opens ${s}, end unknown`;
  if (ms(windowEnd) === ms(windowStart)) return s;
  return `${s} to ${formatClockTime(windowEnd)}`;
}

// ── On-time scoring ───────────────────────────────────────────────────────────────────────────────────

/** "window_end_unknown": only the window start is known and the truck arrived after start + grace, so the
 *  stop cannot honestly be called late (the window may well have run to the evening). */
export type OnTimeStatus = "on_time" | "late" | "no_window" | "not_arrived" | "window_end_unknown";

export interface OnTimeResult {
  status: OnTimeStatus;
  /** The arrival used for the score (GPS when present, else the app tap). */
  arrivalIso?: string;
  source?: "gps" | "app";
  /** Arrival minus window END, in whole minutes (negative = before the end). Set only when the end is known. */
  minutesLate?: number;
  /** Whether the window end was known (a range or a single time from the project timeline). */
  windowEndKnown?: boolean;
  /** Arrival minus window start, whole minutes. */
  minutesAfterStart?: number;
  /** Arrived before the window opened. Shown, but still on time. */
  early?: boolean;
  minutesEarly?: number;
  /** A paid "PIN POINT EXACT TIME" window. */
  pinPoint?: boolean;
  /** On a late result: "high" for a missed exact time window (the most severe), else "normal". */
  severity?: "high" | "normal";
}

/**
 * Score one stop. On time = arrived at or before the window END + grace; arrival before the START is
 * early (on time, flagged). Late minutes = arrival minus window end. With only the start known: on time
 * when within start + grace, else "window_end_unknown" (never "late"). GPS arrival wins over the tap.
 */
export function scoreOnTime(input: {
  windowStart?: string | null;
  windowEnd?: string | null;
  pinPoint?: boolean | null;
  appArrivedAt?: string | null;
  gpsArrivedAt?: string | null;
  graceMin?: number;
}): OnTimeResult {
  const grace = input.graceMin ?? ON_TIME_GRACE_MIN;
  const gps = ms(input.gpsArrivedAt);
  const app = ms(input.appArrivedAt);
  const arrival = gps ?? app;
  const source: "gps" | "app" | undefined = gps != null ? "gps" : app != null ? "app" : undefined;
  const end = ms(input.windowEnd);
  const start = ms(input.windowStart) ?? end;
  if (start == null) {
    return arrival == null ? { status: "no_window" } : { status: "no_window", arrivalIso: new Date(arrival).toISOString(), source };
  }
  const pinPoint = Boolean(input.pinPoint);
  const windowEndKnown = end != null;
  if (arrival == null) return { status: "not_arrived", windowEndKnown, pinPoint };
  const minutesAfterStart = Math.round((arrival - start) / MIN);
  const early = minutesAfterStart < 0;
  const base: OnTimeResult = {
    status: "on_time",
    arrivalIso: new Date(arrival).toISOString(),
    source,
    windowEndKnown,
    minutesAfterStart,
    early,
    ...(early ? { minutesEarly: -minutesAfterStart } : {}),
    pinPoint,
  };
  if (end != null) {
    const minutesLate = Math.round((arrival - end) / MIN);
    if (minutesLate <= grace) return { ...base, minutesLate };
    return { ...base, status: "late", minutesLate, severity: pinPoint ? "high" : "normal" };
  }
  return minutesAfterStart <= grace ? base : { ...base, status: "window_end_unknown" };
}

/** Board badge for an on-time result: a short label and a tone. Null when there is nothing to score yet. */
export function onTimeBadge(r: OnTimeResult): { label: string; tone: "positive" | "critical" | "neutral" } | null {
  if (r.status === "on_time") {
    if (r.early && (r.minutesEarly ?? 0) > 0) return { label: `Early ${formatDuration(r.minutesEarly ?? 0)}`, tone: "neutral" };
    return { label: "On time", tone: "positive" };
  }
  if (r.status === "late") {
    const by = formatDuration(r.minutesLate ?? 0);
    return r.pinPoint ? { label: `Missed exact time by ${by}`, tone: "critical" } : { label: `Late ${by}`, tone: "critical" };
  }
  if (r.status === "window_end_unknown") return { label: "Window end unknown", tone: "neutral" };
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
  /** Customer window end (ISO); null/undefined = only the start is known. */
  windowEnd?: string | null;
  /** A paid exact-time window. */
  pinPoint?: boolean | null;
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
    windowEnd: s.windowEnd ?? null,
    pinPoint: s.windowPinPoint ?? false,
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
  /** Window end (ISO) when known; minutesPastWindow is then measured from it. */
  windowEnd?: string;
  windowEndKnown?: boolean;
  pinPoint?: boolean;
  estArrival: string;
  /** Estimated arrival minus the window END when known, else minus the window start. */
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

/**
 * Stops whose estimated arrival would miss their window: more than STACK_WARN_PAST_END_MIN past the
 * window END when it is known, else more than `thresholdMin` past the window start (labelled "window end
 * unknown", since the window may still be open).
 */
export function stackingWarnings(stops: PlanStop[], thresholdMin: number = STACK_WARN_MIN): StackWarning[] {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const est = estimateArrivals(ordered);
  const out: StackWarning[] = [];
  ordered.forEach((s, i) => {
    const end = ms(s.windowEnd);
    const win = ms(s.windowStart) ?? end;
    const arr = est[i].estArrivalMs;
    if (win == null || arr == null) return;
    const endKnown = end != null;
    const past = Math.round((arr - (endKnown ? end : win)) / MIN);
    if (past <= (endKnown ? STACK_WARN_PAST_END_MIN : thresholdMin)) return;
    const pinPoint = Boolean(s.pinPoint);
    const windowStart = new Date(win).toISOString();
    const windowEnd = endKnown ? new Date(end).toISOString() : undefined;
    const estArrival = new Date(arr).toISOString();
    const who = s.custName || "This stop";
    const head = endKnown
      ? `${who} is planned for ${formatClockTime(estArrival)}, ${formatDuration(past)} after the ${pinPoint ? "exact time window" : "window"} closes at ${formatClockTime(windowEnd)}.`
      : `${who} is planned for ${formatClockTime(estArrival)}, ${formatDuration(past)} after the window opens at ${formatClockTime(windowStart)}. Window end unknown.`;
    const common = { stopId: s.stopId, custName: s.custName, windowStart, windowEnd, windowEndKnown: endKnown, pinPoint, estArrival, minutesPastWindow: past };
    if (i === 0) {
      out.push({ ...common, cause: "planned_late", message: head });
      return;
    }
    const prev = ordered[i - 1];
    const pe = est[i - 1];
    const dur = pe.onSiteDefaulted
      ? `${formatDuration(pe.onSiteMin)} on site (default, no duration in Goodshuffle)`
      : `${formatDuration(pe.onSiteMin)} on site`;
    out.push({
      ...common,
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
