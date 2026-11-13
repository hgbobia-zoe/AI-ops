// Goodshuffle's own route start and end (getRoute startDate / endDate): leaving the warehouse and back at the
// warehouse. Owner rule (2026-11-13): crew shifts match these, rounded to the quarter hour (quarterHour.ts).
// Pure, shared by the route import (what we store) and the risk engine (what the window is).

const DAY_MS = 24 * 3600 * 1000;

/** Start and end in ms when both parse, the end is after the start, and the route is under a day long. */
export function gsRouteSpanMs(start: unknown, end: unknown): { start: number; end: number } | null {
  if (typeof start !== "string" || typeof end !== "string" || !start || !end) return null;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s || e - s > DAY_MS) return null;
  return { start: s, end: e };
}

/** The pair to store on a route (ISO), or nothing, so the crew window falls back to the stop times. */
export function routeTimes(start: unknown, end: unknown): { gsStart?: string; gsEnd?: string } {
  const span = gsRouteSpanMs(start, end);
  return span ? { gsStart: new Date(span.start).toISOString(), gsEnd: new Date(span.end).toISOString() } : {};
}
