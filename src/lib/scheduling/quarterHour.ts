// Crew shift starts land on the quarter hour.
//
// A route's crew window is derived from its stop times (first stop minus the load buffer), so it used to
// start on odd minutes like 8:03, and that exact minute went into the app and into Connecteam. Owner rule
// (2026-11-12): round the crew START to the NEAREST quarter hour (:00 :15 :30 :45) on the Eastern wall
// clock. On whole minutes past a quarter, 0 to 7 rounds down and 8 to 14 rounds up: 8:03 → 8:00,
// 7:54 → 8:00, 7:52 → 7:45, 7:53 → 8:00, 7:40 → 7:45. So a start can move up to 7 minutes LATER than the
// computed crew start (the owner chose nearest over always earlier).
//
// Only the start is rounded. The END stays exactly as the route sets it (it is not moved and not rounded).
// If rounding would put the start at or after the end (a very short shift), the original start is kept.
// Customer facing stop windows and ETAs are untouched: this only shapes CREW shift windows.

import { DISPLAY_TZ } from "@/lib/dates";
import type { RouteWindow } from "@/lib/risk/engine";

const MIN_MS = 60 * 1000;
const QUARTER_MS = 15 * MIN_MS;

/** Minutes to add to a UTC instant to get wall clock time in `tz` at that instant (e.g. -300 in EST). */
function offsetMinutes(tz: string, ms: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(ms))
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Round an instant to the NEAREST quarter hour on the wall clock in `tz` (Eastern by default), judged on
 *  whole minutes past the quarter: 0 to 7 rounds down, 8 to 14 rounds up (seconds are dropped first, so
 *  7:52:59 is still 7:52 → 7:45). Rolls over the hour and the date (11:53 PM → 12:00 AM next day). Pure. */
export function roundToNearestQuarterHour(ms: number, tz: string = DISPLAY_TZ): number {
  const off = offsetMinutes(tz, ms) * MIN_MS;
  const local = ms + off;
  const intoQuarter = ((local % QUARTER_MS) + QUARTER_MS) % QUARTER_MS;
  const down = local - intoQuarter;
  const minutesPast = Math.floor(intoQuarter / MIN_MS);
  const rounded = minutesPast >= 8 ? down + QUARTER_MS : down;
  return rounded - off;
}

/** The CREW window for a route: start rounded to the nearest quarter hour, end left exactly as the route
 *  sets it. Keeps the original start if rounding would reach the end. Raw stop times are untouched. Pure. */
export function crewWindow(w: RouteWindow, tz: string = DISPLAY_TZ): RouteWindow {
  const startUnix = Math.round(roundToNearestQuarterHour(w.startUnix * 1000, tz) / 1000);
  if (startUnix >= w.endUnix) return w;
  return { ...w, startUnix };
}
