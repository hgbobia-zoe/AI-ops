// Instawork snapshot store. The browser Auto-Pull extension fetches the gig groups same-origin (carrying
// the operator's Instawork session) and POSTs them to /api/instawork/import, which saves the parsed
// shifts here. Every server read (Scheduling board, reconcile, health) reads this snapshot — the server
// NEVER calls Instawork itself (avoids the datacenter-IP block). Persisted in the settings KV, mirroring
// src/lib/pull/state.ts. Never throws: a parse failure reads as null.

import { getDb } from "@/lib/db";
import type { InstaworkShift } from "./types";

const KEY = "instawork.snapshot";

/** How recent the browser pull must be for Instawork to count as fresh/connected. The extension pulls on
 *  the same ~10-min cycle as Goodshuffle; 120 min leaves ample slack before we call the session stale. */
export const INSTAWORK_STALE_MIN = 120;

export interface InstaworkSnapshot {
  shifts: InstaworkShift[];
  fetchedAt: string; // ISO of when the browser pull fetched these
}

/** Persist the latest browser-pulled Instawork shifts. Never throws. */
export function saveInstaworkSnapshot(shifts: InstaworkShift[], fetchedAt: string): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY, JSON.stringify({ shifts, fetchedAt } satisfies InstaworkSnapshot), new Date().toISOString());
  } catch {
    /* best-effort — the ingest still reports what it stored */
  }
}

/** The latest snapshot, or null if none has been pulled yet (or the row failed to parse). Synchronous. */
export function readInstaworkSnapshot(): InstaworkSnapshot | null {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as InstaworkSnapshot;
    if (!parsed || !Array.isArray(parsed.shifts) || typeof parsed.fetchedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
