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
