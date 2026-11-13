// Calendar-day helpers.
//
// Timestamps elsewhere (arrivedAt, completedAt, event ts) are correctly stored as
// UTC ISO instants — those are points in time and need no timezone. This module is
// only for deriving *which calendar day* a route belongs to, which IS timezone-
// sensitive: the server runs in UTC on Fly, so a route imported at 9pm ET would land
// under tomorrow's date if "today" were taken from `new Date().toISOString()`. We
// compute it in the operating timezone instead (ETA_TIMEZONE, default America/New_York).

const DEFAULT_TZ = "America/New_York";

/**
 * The timezone all human-facing times are displayed in (dashboard, driver
 * notification log, etc.). Reads `ETA_TIMEZONE` on the server; on the client that
 * env is absent so it resolves to America/New_York — which is where the operation
 * runs, so every screen shows Eastern time regardless of the device's own clock.
 */
export const DISPLAY_TZ = process.env.ETA_TIMEZONE || DEFAULT_TZ;

/** `YYYY-MM-DD` for instant `d` in IANA timezone `tz`. (en-CA formats as YYYY-MM-DD.) */
export function ymdInTz(tz: string, d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * "Today" as a `YYYY-MM-DD` date in the operating timezone. Reads `ETA_TIMEZONE`
 * (server); on the client that env is absent and it falls back to America/New_York,
 * which is where the tablets run — so both sides agree on the day.
 */
export function todayInOpsTz(d: Date = new Date()): string {
  return ymdInTz(process.env.ETA_TIMEZONE || DEFAULT_TZ, d);
}

/**
 * The ISO date (`YYYY-MM-DD`) for the start of the CURRENT OPERATING YEAR — Jan 1 of the current
 * calendar year in the operating timezone (so it rolls over with the clock, never hardcoded). This is
 * the single boundary the SERVER-SIDE, NON-FINANCIAL data paths use to exclude prior years: treat it as
 * ">= start of current year", which keeps current-year AND future-dated records and drops only older
 * ones. Financial paths DO NOT use this — they keep full multi-year history.
 *
 * DYNAMIC + centralized: callers pass the optional settings override (see settings.operatingYearStart),
 * which may be a bare year (`"2026"`) or a full date (`"2026-01-01"`); anything else falls back to the
 * computed current-year start. Pure (no DB) so it's safe on the client too; the DB override is resolved
 * by the server-side caller and handed in.
 */
export function currentOperatingYearStart(now: Date = new Date(), override?: string | null): string {
  if (override) {
    const t = override.trim();
    if (/^\d{4}$/.test(t)) return `${t}-01-01`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    // Malformed override → ignore it and fall through to the computed current-year start.
  }
  const year = todayInOpsTz(now).slice(0, 4);
  return `${year}-01-01`;
}

/** Shift a `YYYY-MM-DD` string by `days` (may be negative); returns `YYYY-MM-DD`. */
export function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → "Wed, Sep 3" for headings. Parsed as a plain calendar day (UTC). */
export function formatYmdLong(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

// Matches an ISO-8601 datetime like 2026-08-31T09:00:00.000-04:00 (with or without
// fractional seconds / offset). Goodshuffle stops arrive with raw ISO windows/ETAs.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Format a stop's time field for display. Goodshuffle delivers windows/ETAs as raw
 * ISO instants (`2026-08-31T09:00:00.000-04:00`), which are unreadable on the tablet;
 * we render those as clock time in the operating timezone (`9:00 AM`). Manual-entry
 * values are free text ("morning", "1–3 PM") and pass through unchanged.
 */
export function formatClockTime(value?: string | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!ISO_DATETIME.test(trimmed)) return trimmed;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return trimmed;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

// ── Eastern time: the ONE shared helper ───────────────────────────────────────────────────────────────
// Every shift and route time is an absolute instant, shown and entered on the Eastern wall clock
// (America/New_York via DISPLAY_TZ). Never hard code -04:00 / -05:00 and never use the host clock (Fly runs
// in UTC, browsers can be anywhere): DST moves the offset twice a year (EDT -4 until the first Sunday of
// November, then EST -5). These helpers ask Intl for the real offset at the instant in question.

/** Minutes to add to a UTC instant to get the wall-clock time in `tz` at that instant (-240 in EDT,
 *  -300 in EST for America/New_York). Whole minutes (sub-second parts of `date` are ignored). */
export function tzOffsetMinutes(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** The Eastern (operating tz) UTC offset in minutes at instant `ms`: -240 in EDT, -300 in EST. */
export function opsOffsetMinutes(ms: number, tz: string = DISPLAY_TZ): number {
  return tzOffsetMinutes(tz, new Date(ms));
}

/** Eastern wall clock time on calendar day `ymd` (`hour` 0 to 24, `minute`) → the real epoch ms. DST
 *  correct on both sides of the switch: the offset is taken at the resulting instant, not at a guess or at
 *  "now", so 8:00 on an EDT day is 12:00Z and 8:00 on an EST day is 13:00Z. Hour 24 is the next midnight. */
export function opsWallTimeToMs(ymd: string, hour: number, minute = 0, tz: string = DISPLAY_TZ): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0, 0);
  const first = guess - tzOffsetMinutes(tz, new Date(guess)) * 60000;
  const off = tzOffsetMinutes(tz, new Date(first));
  return guess - off * 60000;
}

/** `YYYY-MM-DD` of instant `ms` on the Eastern calendar (never the UTC date, which flips at 7 or 8 PM ET). */
export function opsYmdOfMs(ms: number, tz: string = DISPLAY_TZ): string {
  return ymdInTz(tz, new Date(ms));
}

/** Minutes past Eastern midnight of day `ymd` for instant `ms`, by the wall clock (so on the two DST switch
 *  days 8:00 AM is still 480, not 420 or 540). Can be negative or past 1440 for instants on other days. */
export function opsMinutesIntoDay(ms: number, ymd: string, tz: string = DISPLAY_TZ): number {
  const midnight = opsWallTimeToMs(ymd, 0, 0, tz);
  const wall = (t: number): number => t + tzOffsetMinutes(tz, new Date(t)) * 60000;
  return Math.round((wall(ms) - wall(midnight)) / 60000);
}

/** The last instant (23:59:59.999 local) of calendar day `ymd` in the operating timezone, as a UTC ISO
 *  string. A safe end-of-day window bound when a stop has no scheduled time (never fabricates a time). */
export function endOfOpsDayISO(ymd: string): string {
  const tz = process.env.ETA_TIMEZONE || DEFAULT_TZ;
  return new Date(opsWallTimeToMs(shiftYmd(ymd, 1), 0, 0, tz) - 1).toISOString();
}

/**
 * ISO instant → the value a `<input type="datetime-local">` wants (local wall-clock, no tz suffix),
 * rendered in the OPERATING timezone (America/New_York by default). This exists because the obvious
 * `d.getFullYear()/getHours()` approach reads the HOST/BROWSER timezone, so a Dispatch user whose machine
 * isn't on Eastern would see — and save — shift times shifted by their own tz offset. Pinning ET here makes
 * a shift show (and round-trip) the SAME wall-clock Connecteam shows, regardless of the viewer's device.
 */
export function isoToOpsLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: DISPLAY_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const hour = p.hour === "24" ? "00" : p.hour; // some engines render midnight as 24
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
}

// ── Business-day math (ops timezone) ────────────────────────────────────────────────────────────────
// Used by the e-signature cutoff (src/lib/salesos/esignCutoff.ts): disable online signing N BUSINESS days
// before an event. "Business day" = Mon–Fri. Holidays are intentionally OUT OF SCOPE here — a public-
// holiday calendar would need a jurisdiction + an annual data source we don't have, so a holiday counts
// as a business day for now; the small effect is that a cutoff MAY fire one calendar day earlier than a
// holiday-aware version would. Documented so a later holiday feed is a drop-in, not a surprise.

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Is `ymd` (a plain calendar day) a weekday (Mon–Fri)? Parsed as UTC so the weekday is tz-stable. */
export function isBusinessDay(ymd: string): boolean {
  if (!YMD_RE.test(ymd)) return false;
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun … 6 Sat
  return dow >= 1 && dow <= 5;
}

/**
 * Business days (Mon–Fri) from TODAY (in the ops timezone) to the event day `eventYmd`:
 *   • event is today            → 0
 *   • event is in the future    → count of weekdays strictly after today, up to and including the event
 *                                  (so Mon→Thu = 3: Tue, Wed, Thu). Weekends don't count.
 *   • event is in the past      → NEGATIVE (the weekday count back to it), so callers can exclude it
 *   • malformed date            → NaN
 * Pure given `now`, so it's unit-testable across weekend spans and the exact boundary.
 */
export function businessDaysUntil(eventYmd: string, now: Date = new Date()): number {
  if (!YMD_RE.test(eventYmd)) return NaN;
  const today = todayInOpsTz(now);
  if (eventYmd === today) return 0;
  let count = 0;
  if (eventYmd > today) {
    let cur = today;
    while (cur < eventYmd) {
      cur = shiftYmd(cur, 1);
      if (isBusinessDay(cur)) count++;
    }
    return count;
  }
  // Past: walk forward from the event to today and negate, so a past event reads as < 0.
  let cur = eventYmd;
  while (cur < today) {
    cur = shiftYmd(cur, 1);
    if (isBusinessDay(cur)) count++;
  }
  return -count;
}

/** True when `eventYmd` is today or up to `n` business days out (never for a past event). `n` = 3 for the
 *  e-signature cutoff. Weekends are excluded by businessDaysUntil, so Fri→next-Wed is 3 business days. */
export function isWithinBusinessDays(eventYmd: string, n: number, now: Date = new Date()): boolean {
  const d = businessDaysUntil(eventYmd, now);
  return Number.isFinite(d) && d >= 0 && d <= n;
}

/**
 * Inverse of isoToOpsLocalInput: interpret a `datetime-local` wall time (no tz) in the OPERATING timezone
 * and return the absolute UTC ISO instant. Never `new Date("<local>")` — that reads the string in the
 * host/browser tz and silently shifts the shift's time (the exact bug this replaces). Returns null on blank.
 */
export function opsLocalInputToIso(local: string | null): string | null {
  if (!local || !local.trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local.trim());
  if (!m) return null;
  return new Date(opsWallTimeToMs(`${m[1]}-${m[2]}-${m[3]}`, Number(m[4]), Number(m[5]))).toISOString();
}
