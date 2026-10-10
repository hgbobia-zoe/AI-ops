// Durable state for the Route Staffing Pre-Check: the "mark done" acks and the alert dedupe bookkeeping.
// Both live as ONE namespaced JSON row in the settings table (via kv.ts) — additive, no migration, exactly
// the pattern pull/state.ts and instawork/store.ts use. Keyed by (date|routeId).
//
// Two concerns:
//   • ACK ("mark done") — an owner/admin says "this route is handled (old way / solo), stop holding its
//     debrief." The ack snapshots the CURRENT assigned crew (assignedSig); if staffing later CHANGES the
//     snapshot no longer matches and the ack lapses (the route is re-evaluated) — so an ack can't silently
//     mask a route someone later pulled crew off of.
//   • ALERT DEDUPE — one Slack per route per gap with a cool-off, re-alert if the gap persists past the
//     cool-off or WORSENS, and one "recovered" note when it clears. Mirrors recordIgnitionProbe exactly.

import { getJson, setJson } from "@/lib/kv";
import type { RoleCount } from "./preCheck";

const KEY = "scheduling.precheck";

/** 2h cool-off between repeat alerts for the same still-gapped route — matches pull/state's ALERT_COOLOFF. */
export const PRECHECK_ALERT_COOLOFF_MS = 2 * 60 * 60 * 1000;

export interface PreCheckAck {
  at: string; // ISO when marked done
  actor: string; // who marked it
  /** Snapshot of the assigned crew at ack time; the ack lapses when current staffing differs. */
  assignedSig: string;
}

interface AlertRecord {
  firstGapAt: string; // ISO the gap was first seen
  lastAlertedAt?: string; // ISO we last Slacked this route's gap
  lastTotalGap: number; // the gap severity at the last alert (to detect worsening)
}

interface PreCheckState {
  acks?: Record<string, PreCheckAck>;
  alerts?: Record<string, AlertRecord>;
}

function routeKey(date: string, routeId: string): string {
  return `${date}|${routeId}`;
}

/** Canonical signature of an assigned-crew count, so an ack is tied to the exact staffing it approved. */
export function assignedSig(assigned: RoleCount): string {
  return `d:${assigned.driver},f:${assigned.field}`;
}

function read(): PreCheckState {
  return getJson<PreCheckState>(KEY, {});
}
function write(s: PreCheckState): void {
  setJson(KEY, s);
}

// ── Ack ("mark done") ─────────────────────────────────────────────────────────────────────────────────

export function getPreCheckAck(date: string, routeId: string): PreCheckAck | null {
  return read().acks?.[routeKey(date, routeId)] ?? null;
}

export function setPreCheckAck(date: string, routeId: string, actor: string, sig: string, now: Date = new Date()): void {
  const s = read();
  s.acks = s.acks ?? {};
  s.acks[routeKey(date, routeId)] = { at: now.toISOString(), actor, assignedSig: sig };
  write(s);
}

export function clearPreCheckAck(date: string, routeId: string): void {
  const s = read();
  if (s.acks) delete s.acks[routeKey(date, routeId)];
  write(s);
}

// ── Alert dedupe ────────────────────────────────────────────────────────────────────────────────────

/** The PURE alert decision (unit-tested). Given the prior alert record for a route, the current gap
 *  severity, and now, decide whether to Slack — and the next record to persist. Rules, mirroring the
 *  ignition/instawork probes:
 *    • status "gap"  → alert when never alerted, OR the gap WORSENED (totalGap grew), OR the cool-off
 *                      elapsed since the last alert. Otherwise stay quiet.
 *    • status "ok"/"resolved" (gap cleared) → emit ONE "recovered" note iff we had alerted; then forget it. */
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
