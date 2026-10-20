// One-shot "force-archive deleted Goodshuffle projects" marker. The bookings pull normally REFUSES to
// archive orphans (projects Goodshuffle DELETED) when more than a handful of active bookings go missing
// from the pulled set at once — that usually means a truncated pull, not real deletions (see
// archiveBookingsNotIn + the ingest route's cap of 15). When a human has DELIBERATELY deleted a large
// batch of projects in Goodshuffle, they arm this one-shot so the NEXT COMPLETE pull archives ALL orphans
// regardless of the cap, then it disarms itself.
//
// Persisted in the settings KV (mirroring src/lib/pull/state.ts and src/lib/ingest/forceResync.ts) so it
// survives a restart between the arm and the next pull. It is a bare boolean with NO TTL because it only
// ever fires on a COMPLETE, >=100-record pull (the ingest route enforces that floor before consuming it),
// so a stale flag can never mass-archive on a truncated pull; and it clears itself the moment such a pull
// consumes it.

import { getDb } from "@/lib/db";

const KEY = "bookings_force_prune_once";

function save(armed: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(KEY, armed ? "1" : "0", new Date().toISOString());
}

/** Arm the one-shot force-prune. The next COMPLETE pull sweeps every orphan, then disarms it. */
export function armBookingsForcePrune(): void {
  save(true);
}

/** True iff armed — AND clears it (one-shot). Never throws: a read failure reads as "not armed", so a
 *  broken settings store can never force a mass-archive. */
export function consumeBookingsForcePrune(): boolean {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    const armed = row?.value === "1";
    if (armed) save(false);
    return armed;
  } catch {
    return false;
  }
}

/** Whether the one-shot is currently armed, WITHOUT consuming it (for a status read). Never throws. */
export function isBookingsForcePruneArmed(): boolean {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    return row?.value === "1";
  } catch {
    return false;
  }
}
