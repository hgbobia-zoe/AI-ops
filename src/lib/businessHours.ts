// Business hours — the single, deterministic source of truth for "are we open right now?", computed in
// the OPERATING timezone (ETA_TIMEZONE, default America/New_York), never the server's local/UTC clock.
//
// The owner's rule: the AI "bots" must not make RECOMMENDATIONS or send customer-facing messages outside
// business hours. The server-job clock ticks every 15 min, day and night; the recommendation/alert jobs
// consult isWithinBusinessHours() and HOLD (skip + log) when closed — a held recommendation is never
// dropped, it simply runs on the next in-hours tick.
//
// RULES CALCULATE: everything here is pure/total (no DB, no I/O, never throws), so it's safe on the client
// too and fully unit-testable. The admin-editable schedule lives in settings.ts (businessHours setting);
// this module only knows how to interpret a schedule, with the in-code DEFAULT as the floor when unset or
// malformed. Default: Mon-Fri 10:00-18:00, Sat 10:00-13:00, Sun closed. Inclusive of the open minute,
// exclusive of the close minute.

import { ymdInTz, shiftYmd, opsLocalInputToIso } from "./dates";

/** One weekday's open/close as "HH:MM" wall-clock strings in the ops timezone. */
export interface DayHours {
  open: string; // "HH:MM" (inclusive)
  close: string; // "HH:MM" (exclusive)
}

/** A weekly schedule keyed by weekday number "0".."6" (0 = Sunday … 6 = Saturday). A null day is CLOSED. */
export type BusinessHoursSchedule = Record<string, DayHours | null>;

/** The in-code default schedule — the floor used whenever the admin override is unset or malformed. */
export const DEFAULT_BUSINESS_HOURS: BusinessHoursSchedule = {
  "0": null, // Sunday — closed
  "1": { open: "10:00", close: "18:00" }, // Monday
  "2": { open: "10:00", close: "18:00" }, // Tuesday
  "3": { open: "10:00", close: "18:00" }, // Wednesday
  "4": { open: "10:00", close: "18:00" }, // Thursday
  "5": { open: "10:00", close: "18:00" }, // Friday
  "6": { open: "10:00", close: "13:00" }, // Saturday — half day
};

const WEEKDAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"] as const;

function opsTz(): string {
  // Read at call time (mirrors dates.ts) so a test or deployment that sets ETA_TIMEZONE is honored.
  return process.env.ETA_TIMEZONE || "America/New_York";
}

/** "HH:MM" → minutes since local midnight (0..1440), or null when malformed. Hour 24 (==24:00) allowed as
 *  an end-of-day close bound; minutes 0..59, hour 0..24. Pure + total. */
export function parseHM(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  const total = h * 60 + min;
  if (total > 1440) return null;
  return total;
}

/** Is `day` a usable {open,close} with open strictly before close? */
function validDay(day: unknown): day is DayHours {
  if (!day || typeof day !== "object") return false;
  const o = parseHM((day as DayHours).open);
  const c = parseHM((day as DayHours).close);
  return o != null && c != null && o < c;
}

/**
 * Normalize an arbitrary value into a full 0-6 schedule. Each weekday resolves independently:
 *   • an explicit null                 → CLOSED that day (a legitimate admin choice, preserved)
 *   • a valid {open,close}             → used as-is
 *   • anything else (missing/garbage)  → falls back to that weekday's in-code DEFAULT
 * A non-object input (null/undefined/garbage) yields a clone of the full DEFAULT. So bad or empty config
 * always degrades to the safe default, never to "always open" or a throw. Pure + total.
 */
export function sanitizeSchedule(raw: unknown): BusinessHoursSchedule {
  const out: BusinessHoursSchedule = {};
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  for (const k of WEEKDAY_KEYS) {
    if (!obj || !(k in obj)) {
      out[k] = DEFAULT_BUSINESS_HOURS[k];
      continue;
    }
    const v = obj[k];
    if (v === null) out[k] = null; // explicit closed
    else if (validDay(v)) out[k] = { open: (v as DayHours).open.trim(), close: (v as DayHours).close.trim() };
    else out[k] = DEFAULT_BUSINESS_HOURS[k]; // garbage → default for this weekday
  }
  return out;
}

/** Weekday (0 Sun..6 Sat) + minutes-since-midnight for instant `now`, both read in the ops timezone. The
 *  date and the clock come from the SAME instant formatted in the SAME tz, so they never disagree across
 *  the UTC/ET day boundary (a late-evening-ET instant that is already "tomorrow" in UTC still reads as the
 *  ET weekday and ET clock). Pure given `now`. */
function opsWallClock(now: Date): { dow: number; minutes: number } {
  const tz = opsTz();
  // Weekday via the tz-stable trick already used in dates.ts (ymd in tz, then UTC-parse for the weekday).
  const ymd = ymdInTz(tz, now);
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  // Wall-clock hour/minute in the same tz.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const hour = hh === 24 ? 0 : hh; // some engines render midnight as 24
  return { dow, minutes: hour * 60 + mm };
}

/**
 * Is `now` within business hours, in the ops timezone? Inclusive of the open minute, exclusive of the
 * close minute (so an 18:00 close means 17:59 is open, 18:00 is closed). A closed (null) weekday is always
 * false. `hours` defaults to the configured/default schedule via sanitizeSchedule, so a bad/partial
 * schedule degrades to the in-code default. Pure + total; never throws.
 */
export function isWithinBusinessHours(now: Date = new Date(), hours?: BusinessHoursSchedule): boolean {
  const schedule = sanitizeSchedule(hours);
  const { dow, minutes } = opsWallClock(now);
  const day = schedule[String(dow)];
  if (!day) return false; // closed weekday
  const open = parseHM(day.open);
  const close = parseHM(day.close);
  if (open == null || close == null) return false; // defensive (sanitizeSchedule already guards)
  return minutes >= open && minutes < close;
}

/**
 * The next instant the business opens, at or after `now`. When `now` is already within business hours it
 * returns `now` (we're open). Otherwise it scans forward up to 8 days for the next open weekday and returns
 * that day's open-minute as a real UTC instant. Returns null only if the schedule has no open day at all.
 * For honest "held until …" messaging. Pure given `now`; never throws.
 */
export function nextOpenAt(now: Date = new Date(), hours?: BusinessHoursSchedule): Date | null {
  const schedule = sanitizeSchedule(hours);
  if (isWithinBusinessHours(now, schedule)) return now;
  const tz = opsTz();
  const todayYmd = ymdInTz(tz, now);
  for (let offset = 0; offset <= 8; offset++) {
    const ymd = shiftYmd(todayYmd, offset);
    const [y, m, d] = ymd.split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const day = schedule[String(dow)];
    if (!day) continue;
    const iso = opsLocalInputToIso(`${ymd}T${day.open}`);
    if (!iso) continue;
    const openInstant = new Date(iso);
    if (openInstant.getTime() >= now.getTime()) return openInstant;
    // offset 0 but the open time already passed today (we're after close) → keep scanning.
  }
  return null;
}

/** A short human label for the next open time in the ops timezone, e.g. "Mon 10:00 AM ET". Falls back to a
 *  generic phrase if the schedule somehow has no open day. Pure given `now`; never throws. */
export function nextOpenLabel(now: Date = new Date(), hours?: BusinessHoursSchedule): string {
  const at = nextOpenAt(now, hours);
  if (!at) return "the next business day";
  const tz = opsTz();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  const hour = get("hour");
  const minute = get("minute");
  const dayPeriod = get("dayPeriod");
  // "ET" is the common label for the ops tz; keep it generic rather than guessing EST/EDT.
  const tzAbbr = tz === "America/New_York" ? "ET" : tz;
  return `${weekday} ${hour}:${minute} ${dayPeriod} ${tzAbbr}`.replace(/\s+/g, " ").trim();
}
