// Crew shift starts land on the quarter hour.
//
// A route's crew window is derived from its stop times (first stop minus the load buffer), so it used to
// start on odd minutes like 8:03, and that exact minute went into the app and into Connecteam. Owner rule
// (2026-11-12): round the crew start DOWN to the previous quarter hour (:00 :15 :30 :45), never the
// nearest, so crew are never scheduled later than the route needs them. 8:03 → 8:00, 7:54 → 7:45, and a
// start already on a quarter stays put. The shift keeps its planned length, so the end moves earlier by
// the same minutes (the end is not rounded on its own). Customer facing stop windows and ETAs are untouched:
// this only shapes CREW shift windows.

import { DISPLAY_TZ } from "@/lib/dates";
import type { RouteWindow } from "@/lib/risk/engine";

const QUARTER_MS = 15 * 60 * 1000;

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

/** Round an instant DOWN to the previous quarter hour on the wall clock in `tz` (Eastern by default).
 *  Seconds are dropped too. An instant already on a quarter is returned unchanged. Pure. */
export function floorToQuarterHour(ms: number, tz: string = DISPLAY_TZ): number {
  const off = offsetMinutes(tz, ms) * 60000;
  const local = ms + off;
  return local - (((local % QUARTER_MS) + QUARTER_MS) % QUARTER_MS) - off;
}

/** The CREW window for a route: start floored to the quarter hour, same length (end moves by the same
 *  minutes). Raw stop times (rawStart/rawEnd) are left as they are. Pure. */
export function crewWindow(w: RouteWindow, tz: string = DISPLAY_TZ): RouteWindow {
  const startMs = w.startUnix * 1000;
  const shiftMs = startMs - floorToQuarterHour(startMs, tz);
  const shiftSec = Math.round(shiftMs / 1000);
  return { ...w, startUnix: w.startUnix - shiftSec, endUnix: w.endUnix - shiftSec };
}
