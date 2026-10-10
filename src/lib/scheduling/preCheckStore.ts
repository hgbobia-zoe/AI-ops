// Durable state for the Route Staffing Pre-Check: the Slack-alert dedupe bookkeeping. One namespaced JSON
// row in the settings table (via kv.ts) — additive, no migration, exactly the pattern pull/state.ts and
// instawork/store.ts use. Keyed by (date|routeId).
//
// There is NO ack / "mark done": a gap closes ONLY by actually assigning crew, so nothing a human can set
// here suppresses the hold. This store holds only the ALERT DEDUPE: one Slack per route per gap with a
// cool-off, re-alert if the gap persists past the cool-off or WORSENS, and one "recovered" note when the
// gap clears (by assignment). Mirrors recordIgnitionProbe exactly.

import { getJson, setJson } from "@/lib/kv";

const KEY = "scheduling.precheck";

/** 2h cool-off between repeat alerts for the same still-gapped route — matches pull/state's ALERT_COOLOFF. */
export const PRECHECK_ALERT_COOLOFF_MS = 2 * 60 * 60 * 1000;

interface AlertRecord {
  firstGapAt: string; // ISO the gap was first seen
  lastAlertedAt?: string; // ISO we last Slacked this route's gap
  lastTotalGap: number; // the gap severity at the last alert (to detect worsening)
}

interface PreCheckState {
  alerts?: Record<string, AlertRecord>;
}

function routeKey(date: string, routeId: string): string {
  return `${date}|${routeId}`;
}

function read(): PreCheckState {
  return getJson<PreCheckState>(KEY, {});
}
function write(s: PreCheckState): void {
  setJson(KEY, s);
}

/** The PURE alert decision (unit-tested). Given the prior alert record for a route, the current gap
 *  severity, and now, decide whether to Slack — and the next record to persist. Rules, mirroring the
 *  ignition/instawork probes:
 *    • status "gap"  → alert when never alerted, OR the gap WORSENED (totalGap grew), OR the cool-off
 *                      elapsed since the last alert. Otherwise stay quiet.
 *    • gap cleared (by assignment) → emit ONE "recovered" note iff we had alerted; then forget it. */
export function decidePreCheckAlert(
  prev: AlertRecord | undefined,
  gapped: boolean,
  totalGap: number,
  now: Date,
  cooloffMs: number = PRECHECK_ALERT_COOLOFF_MS,
): { alert: "gap" | "recovered" | null; next: AlertRecord | undefined } {
  if (!gapped) {
    // Cleared. Announce recovery only if we had actually alerted this route; then drop the record.
    const alert = prev?.lastAlertedAt ? "recovered" : null;
    return { alert, next: undefined };
  }
  const firstGapAt = prev?.firstGapAt ?? now.toISOString();
  const alertedAgoMs = prev?.lastAlertedAt ? now.getTime() - Date.parse(prev.lastAlertedAt) : Infinity;
  const worsened = prev != null && totalGap > prev.lastTotalGap;
  const cooledOff = alertedAgoMs > cooloffMs;
  const shouldAlert = prev?.lastAlertedAt == null || worsened || cooledOff;

  if (!shouldAlert) {
    // Keep the record but don't re-stamp lastAlertedAt (preserves the cool-off clock).
    return { alert: null, next: { firstGapAt, lastAlertedAt: prev?.lastAlertedAt, lastTotalGap: prev?.lastTotalGap ?? totalGap } };
  }
  return { alert: "gap", next: { firstGapAt, lastAlertedAt: now.toISOString(), lastTotalGap: totalGap } };
}

/** Apply decidePreCheckAlert against the persisted store for one route, and return the decision. The caller
 *  does the actual Slack post (best-effort); this only owns the dedupe bookkeeping. */
export function recordPreCheckAlert(
  date: string,
  routeId: string,
  gapped: boolean,
  totalGap: number,
  now: Date = new Date(),
): { alert: "gap" | "recovered" | null } {
  const s = read();
  s.alerts = s.alerts ?? {};
  const key = routeKey(date, routeId);
  const { alert, next } = decidePreCheckAlert(s.alerts[key], gapped, totalGap, now);
  if (next) s.alerts[key] = next;
  else delete s.alerts[key];
  write(s);
  return { alert };
}
