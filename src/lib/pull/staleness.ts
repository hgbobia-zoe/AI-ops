// Staleness alarm — Slack heads-up when a Goodshuffle feed hasn't been pulled in a while. Checks
// ROUTES and BOOKINGS independently (a bookings pull no longer masks stale routes). Runs server-side
// on a timer (instrumentation.ts) so a lapse is caught even if no one is looking. Deduped per window.

import { getPullState, markStaleAlerted } from "./state";
import { slackNotify } from "@/lib/notify/slack";

// Before the first-ever pull of a source, measure from server start (durable once a pull lands).
const SERVER_START = Date.now();

function hours(key: string, dflt: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

export function checkPullStaleness(now: number = Date.now()): { stale: boolean; alerted: boolean; parts: string[] } {
  const routeThresh = hours("PULL_STALE_HOURS", 26); // daily + buffer
  const bookThresh = hours("PULL_BOOKINGS_STALE_HOURS", 26);
  const reAlertH = hours("PULL_STALE_REALERT_HOURS", 12);

  const st = getPullState();
  const sources = st.sources ?? {};
  const routeAts = Object.entries(sources)
    .filter(([k]) => k.startsWith("route:"))
    .map(([, v]) => Date.parse(v.at))
    .filter((t) => !Number.isNaN(t));
  const bookingsAt = sources["bookings"] ? Date.parse(sources["bookings"].at) : NaN;

  const routesAgeH = (now - (routeAts.length ? Math.max(...routeAts) : SERVER_START)) / 3_600_000;
  const bookingsAgeH = (now - (Number.isNaN(bookingsAt) ? SERVER_START : bookingsAt)) / 3_600_000;

  const parts: string[] = [];
  if (routesAgeH >= routeThresh) parts.push(routeAts.length ? `routes ${Math.round(routesAgeH)}h ago` : "routes never pulled");
  if (bookingsAgeH >= bookThresh) parts.push(Number.isNaN(bookingsAt) ? "bookings never pulled" : `bookings ${Math.round(bookingsAgeH)}h ago`);

  if (parts.length === 0) return { stale: false, alerted: false, parts };

  const lastAlertMs = st.lastStaleAlertAt ? Date.parse(st.lastStaleAlertAt) : 0;
  if ((now - lastAlertMs) / 3_600_000 < reAlertH) return { stale: true, alerted: false, parts };

  void slackNotify(
    `⚠️ Zoe Ops: stale Goodshuffle data — ${parts.join("; ")}. ` +
      `Open a logged-in Goodshuffle tab and click *Pull Zoe Routes* so dispatch, risk, sales & finance stay current.`,
  );
  markStaleAlerted(new Date(now));
  return { stale: true, alerted: true, parts };
}
