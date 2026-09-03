// Staleness alarm — Slack heads-up when Goodshuffle hasn't been pulled in a while. Critical now
// that the tablet no longer auto-pulls: a forgotten manual pull would silently leave dispatch,
// risk, sales and finance running on stale data. Runs server-side on a timer (see instrumentation.ts),
// so it fires even if no one is looking at the app. Deduped so it alerts once per stale window.

import { getPullState, markStaleAlerted } from "./state";
import { slackNotify } from "@/lib/notify/slack";

// Before the first-ever pull is recorded, measure staleness from server start (persists once a
// real pull lands, since lastPullAt is durable in the DB across restarts).
const SERVER_START = Date.now();

function hours(key: string, dflt: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/** Check freshness; alert once per re-alert window while stale. Returns what it did (for tests). */
export function checkPullStaleness(now: number = Date.now()): { stale: boolean; alerted: boolean; ageH: number } {
  const thresholdH = hours("PULL_STALE_HOURS", 26); // daily pull + buffer
  const reAlertH = hours("PULL_STALE_REALERT_HOURS", 12);

  const st = getPullState();
  const lastMs = st.lastPullAt ? Date.parse(st.lastPullAt) : SERVER_START;
  const ageH = (now - lastMs) / 3_600_000;
  if (ageH < thresholdH) return { stale: false, alerted: false, ageH };

  const lastAlertMs = st.lastStaleAlertAt ? Date.parse(st.lastStaleAlertAt) : 0;
  if ((now - lastAlertMs) / 3_600_000 < reAlertH) return { stale: true, alerted: false, ageH };

  const lastTxt = st.lastPullAt ? `last pull ${Math.round(ageH)}h ago` : "no pull recorded yet";
  void slackNotify(
    `⚠️ Zoe Ops: Goodshuffle hasn't been pulled in ${Math.round(ageH)}h (${lastTxt}). ` +
      `Open a logged-in Goodshuffle tab and click *Pull Zoe Routes* so dispatch, risk, sales & finance stay current.`,
  );
  markStaleAlerted(new Date(now));
  return { stale: true, alerted: true, ageH };
}
