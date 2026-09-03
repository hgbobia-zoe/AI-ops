// Pull freshness state — records the last successful Goodshuffle pull so the app can tell whether
// its data is current (and alert if pulls lapse now that the tablet no longer auto-pulls). Stored
// as one JSON row in the settings table (key "pull_state"); no schema change needed.

import { getDb } from "@/lib/db";

const KEY = "pull_state";

export interface PullState {
  lastPullAt?: string; // ISO of the last successful import
  lastTruck?: string;
  lastStops?: number;
  lastStaleAlertAt?: string; // ISO of the last staleness Slack alert (dedupe)
}

export function getPullState(): PullState {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value) as PullState;
  } catch {
    return {};
  }
}

function save(s: PullState): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(KEY, JSON.stringify(s), new Date().toISOString());
}

/** Record a successful pull (called by the import endpoint). */
export function recordPullSuccess(truckId: string, stops: number, now: Date = new Date()): void {
  const s = getPullState();
  s.lastPullAt = now.toISOString();
  s.lastTruck = truckId;
  s.lastStops = stops;
  save(s);
}

export function markStaleAlerted(now: Date = new Date()): void {
  const s = getPullState();
  s.lastStaleAlertAt = now.toISOString();
  save(s);
}
