// Crew shift starts land on the quarter hour.
//
// A route's crew window is derived from its stop times (first stop minus the load buffer), so it used to
// start on odd minutes like 8:03, and that exact minute went into the app and into Connecteam. Owner rule
// (2026-11-12): round the crew START to the NEAREST quarter hour (:00 :15 :30 :45) on the Eastern wall
// clock. On whole minutes past a quarter, 0 to 7 rounds down and 8 to 14 rounds up: 8:03 → 8:00,
// 7:54 → 8:00, 7:52 → 7:45, 7:53 → 8:00, 7:40 → 7:45. So a start can move up to 7 minutes LATER than the
// computed crew start (the owner chose nearest over always earlier).
//
// Owner rule (2026-11-13): the END is rounded to the nearest quarter hour the same way, so a Goodshuffle
// route that runs 9:35 AM to 1:32 PM gives a 9:30 to 1:30 shift. If rounding would leave the shift empty
// (a very short one), the original times are kept.
// Customer facing stop windows and ETAs are untouched: this only shapes CREW shift windows.

import { DISPLAY_TZ, opsOffsetMinutes } from "@/lib/dates";
import type { RouteWindow } from "@/lib/risk/engine";

const MIN_MS = 60 * 1000;
const QUARTER_MS = 15 * MIN_MS;

/** Round an instant to the NEAREST quarter hour on the wall clock in `tz` (Eastern by default), judged on
 *  whole minutes past the quarter: 0 to 7 rounds down, 8 to 14 rounds up (seconds are dropped first, so
 *  7:52:59 is still 7:52 → 7:45). Rolls over the hour and the date (11:53 PM → 12:00 AM next day). Pure. */
export function roundToNearestQuarterHour(ms: number, tz: string = DISPLAY_TZ): number {
  const off = opsOffsetMinutes(ms, tz) * MIN_MS;
  const local = ms + off;
  const intoQuarter = ((local % QUARTER_MS) + QUARTER_MS) % QUARTER_MS;
  const down = local - intoQuarter;
  const minutesPast = Math.floor(intoQuarter / MIN_MS);
  const rounded = minutesPast >= 8 ? down + QUARTER_MS : down;
  return rounded - off;
}

/** The CREW window for a route: start and end each rounded to the nearest quarter hour. Keeps the original
 *  times if rounding would leave the shift empty. Raw stop times are untouched. Pure. */
export function crewWindow(w: RouteWindow, tz: string = DISPLAY_TZ): RouteWindow {
  const startUnix = Math.round(roundToNearestQuarterHour(w.startUnix * 1000, tz) / 1000);
  const endUnix = Math.round(roundToNearestQuarterHour(w.endUnix * 1000, tz) / 1000);
  if (startUnix >= endUnix) return w;
  return { ...w, startUnix, endUnix };
}
