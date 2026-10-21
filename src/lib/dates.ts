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

/** Minutes to add to a UTC instant to get the wall-clock time in `tz` at that instant (e.g. -240 for
 *  America/New_York in summer). Used to resolve a local wall time to a real UTC instant. */
function tzOffsetMinutes(tz: string, date: Date): number {
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
  return (asUTC - date.getTime()) / 60000;
}

/** The last instant (23:59:59.999 local) of calendar day `ymd` in the operating timezone, as a UTC ISO
 *  string. A safe end-of-day window bound when a stop has no scheduled time (never fabricates a time). */
export function endOfOpsDayISO(ymd: string): string {
  const tz = process.env.ETA_TIMEZONE || DEFAULT_TZ;
  const [y, m, d] = ymd.split("-").map(Number);
  // Guess the instant as if 23:59:59.999 were UTC, then correct by the tz offset at that instant.
  const guess = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  const offsetMin = tzOffsetMinutes(tz, new Date(guess));
  return new Date(guess - offsetMin * 60000).toISOString();
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

/**
 * Inverse of isoToOpsLocalInput: interpret a `datetime-local` wall time (no tz) in the OPERATING timezone
 * and return the absolute UTC ISO instant. Never `new Date("<local>")` — that reads the string in the
 * host/browser tz and silently shifts the shift's time (the exact bug this replaces). Returns null on blank.
 */
export function opsLocalInputToIso(local: string | null): string | null {
  if (!local || !local.trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  // Guess the instant as if the wall time were UTC, then correct by the tz offset at that instant.
  const guess = Date.UTC(y, mo - 1, da, h, mi, 0, 0);
  const offsetMin = tzOffsetMinutes(DISPLAY_TZ, new Date(guess));
  return new Date(guess - offsetMin * 60000).toISOString();
}
