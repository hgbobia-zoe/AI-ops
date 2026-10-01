// Instawork change monitor — catches no-shows / drop-offs without an explicit no-show field (the gig
// list API doesn't expose one). The signal: a worker who WAS booked on a gig disappears from it near or
// after its start time. That's exactly what happens when a no-show is marked (the pro is removed) or a
// pro drops. The runtime pull diffs each gig against the last-seen state and Slack-alerts the drop.
//
// Inherent dedup: we persist the latest state every run, so a drop alerts ONCE (next run, the stored
// state already reflects it). No separate alerted set needed.

import { getDb } from "@/lib/db";
import type { InstaworkShift } from "./types";

const KEY = "instawork_monitor";
/** Only alert when a gig is within this of its start, or already started — avoids churn on far-future gigs. */
const LEAD_MS = 3 * 3_600_000;

export interface GigState {
  filled: number;
  workers: string[];
  startsAt: string;
  position: string;
  name: string;
}
/** gigId → last-seen state. */
export type Snapshot = Record<string, GigState>;

export interface MonitorResult {
  alerts: string[];
  next: Snapshot;
}

/**
 * Diff the current Instawork gigs against the previous snapshot. For any gig near/after its start whose
 * set of booked workers lost someone, emit an alert. Pure — takes the clock, returns the alerts + the
 * next snapshot to persist. New gigs and gigs that only GAINED workers never alert.
 */
export function checkInstaworkChanges(prev: Snapshot, current: InstaworkShift[], nowMs: number = Date.now()): MonitorResult {
  const next: Snapshot = {};
  const alerts: string[] = [];
  for (const g of current) {
    next[g.id] = { filled: g.filled, workers: [...g.workers], startsAt: g.startsAt, position: g.position, name: g.name };
    const p = prev[g.id];
    if (!p) continue; // first time we've seen this gig
    const startMs = Date.parse(g.startsAt);
    const near = !Number.isNaN(startMs) && nowMs >= startMs - LEAD_MS;
    if (!near) continue;
    const lost = p.workers.filter((w) => !g.workers.includes(w));
    if (lost.length > 0) {
      const when = !Number.isNaN(startMs) && startMs < nowMs ? "after start" : "before start";
      alerts.push(
        `⚠️ Instawork: ${lost.join(", ")} dropped off "${g.name} · ${g.position}" (${lost.length} fewer ${when === "after start" ? "— possible NO-SHOW" : "— dropped"}). Reassign internal crew or re-post the gig.`,
      );
    }
  }
  return { alerts, next };
}

function loadSnapshot(): Snapshot {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    if (!row) return {};
    const v = JSON.parse(row.value);
    return v && typeof v === "object" ? (v as Snapshot) : {};
  } catch {
    return {};
  }
}

function saveSnapshot(s: Snapshot): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(KEY, JSON.stringify(s), new Date().toISOString());
}

/** Diff the just-pulled Instawork shifts against the stored snapshot, persist the new one, return alerts
 *  to Slack. Called from the runtime's Instawork pull. Never throws. */
export function runInstaworkMonitor(current: InstaworkShift[], nowMs: number = Date.now()): string[] {
  try {
    const { alerts, next } = checkInstaworkChanges(loadSnapshot(), current, nowMs);
    saveSnapshot(next);
    return alerts;
  } catch {
    return [];
  }
}
