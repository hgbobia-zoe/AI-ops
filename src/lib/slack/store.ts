// Viktor (Slack bot) — dedup store. Slack re-delivers the same `event_id` when an ACK is slow/failed, so
// we insert-once and skip repeats. Returns true only the FIRST time an event is seen.

import { getDb } from "@/lib/db";

/** Record a Slack event_id as handled. Returns true if it's new (process it), false if already seen (skip). */
export function markSlackEventSeen(eventId: string): boolean {
  if (!eventId) return false;
  try {
    const r = getDb()
      .prepare("INSERT OR IGNORE INTO slack_events (event_id, ts) VALUES (?, ?)")
      .run(eventId, new Date().toISOString());
    return r.changes > 0;
  } catch {
    // On a storage hiccup, don't silently drop the message — let it through (a rare duplicate beats a lost ask).
    return true;
  }
}
