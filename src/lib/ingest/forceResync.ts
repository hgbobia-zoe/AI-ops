// One-shot "force re-sync" marker for a route. When the office/driver asks to re-sync a route to
// Goodshuffle's current order, we don't make a server-side Goodshuffle call (Cloudflare blocks the
// server). Instead we ARM a flag here and let the existing browser pull POST the route back through
// /api/route/import, which consumes the flag and applies forceReconcileStops for exactly ONE import.
//
// Persisted in the settings KV (mirroring src/lib/pull/state.ts) so it survives a restart between the
// arm and the next pull. Entries carry a short TTL so a stale flag can never silently re-order a route
// days later; expired entries are pruned on every write.

import { getDb } from "@/lib/db";

const KEY = "route.forceResync";
const TTL_MS = 20 * 60 * 1000; // 20 minutes — long enough to cover the next pull, short enough to be safe

// routeId → expiry ISO
type ForceMap = Record<string, string>;

function read(): ForceMap {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value) as ForceMap;
  } catch {
    return {};
  }
}

function save(m: ForceMap): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(KEY, JSON.stringify(m), new Date().toISOString());
}

/** Drop expired entries (expiry <= now, or unparseable). */
function prune(m: ForceMap, now: number): ForceMap {
  const out: ForceMap = {};
  for (const [id, exp] of Object.entries(m)) {
    const t = Date.parse(exp);
    if (!Number.isNaN(t) && t > now) out[id] = exp;
  }
  return out;
}

/** Arm a one-shot force re-sync for this route (TTL 20 min). Prunes expired entries on write. */
export function markForceResync(routeId: string, now: number = Date.now()): void {
  const m = prune(read(), now);
  m[routeId] = new Date(now + TTL_MS).toISOString();
  save(m);
}

/** True iff this route is armed and unexpired — AND clears it (one-shot). Never throws. */
export function consumeForceResync(routeId: string, now: number = Date.now()): boolean {
  try {
    const m = prune(read(), now);
    const present = Object.prototype.hasOwnProperty.call(m, routeId);
    if (present) {
      delete m[routeId];
      save(m);
    }
    return present;
  } catch {
    return false;
  }
}
