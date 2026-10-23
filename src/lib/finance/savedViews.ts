// Financial Intelligence — Stage 7b saved views (store). A saved view persists the /finance dashboard
// STATE ONLY — the active view, the period (preset key or a custom start/end range), and any project
// filter — under a team-level name, so owner/admins share the same named lenses. No analytics are stored;
// applying a view just reconstructs the URL. Team-level (NOT per-user): a clean, honest Phase-1 choice —
// per-user scoping is a later extension (would add an owner column + the signed uid to every query).
//
// Idempotent by name (case-insensitive): re-saving a name UPDATES that view in place (upsert), so a view
// is a stable handle, not an ever-growing list of duplicates. Server-only (better-sqlite3), mirroring the
// finance/config.ts + finance/laborHistory.ts pattern of a small finance module talking to getDb directly.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

/** The dashboard URL state a saved view captures. All optional — only the keys that matter are stored. */
export interface SavedViewState {
  /** The active view tab (overview | projects | routes | …). */
  view?: string;
  /** A preset period key (thisWeek, thisCycle, …). Mutually exclusive with start/end. */
  period?: string;
  /** Custom range start (YYYY-MM-DD). Set together with `end`. */
  start?: string;
  /** Custom range end (YYYY-MM-DD). Set together with `start`. */
  end?: string;
  /** A selected project id (the per-project profitability drill-down). */
  project?: string;
  /** A selected lineage project id (the data-lineage panel). */
  lineage?: string;
}

export interface SavedViewRow {
  id: string;
  name: string;
  state: SavedViewState;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The only keys a saved view may carry — an allowlist, so nothing arbitrary is persisted or replayed. */
const STATE_KEYS: (keyof SavedViewState)[] = ["view", "period", "start", "end", "project", "lineage"];

export const SAVED_VIEW_NAME_MAX = 60;

/** Trim + length-check a view name. Returns the cleaned name, or null when empty / too long (never throws). */
export function normalizeViewName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = name.trim();
  if (n.length === 0 || n.length > SAVED_VIEW_NAME_MAX) return null;
  return n;
}

/** Keep only the allowlisted keys, coerce each to a trimmed non-empty string, and drop the rest. Pure. */
export function sanitizeViewState(raw: unknown): SavedViewState {
  const out: SavedViewState = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const k of STATE_KEYS) {
    const v = r[k];
    if (typeof v === "string") {
      const t = v.trim();
      if (t) out[k] = t;
    }
  }
  return out;
}

function rowToView(r: Record<string, unknown>): SavedViewRow {
  let state: SavedViewState = {};
  try {
    state = sanitizeViewState(JSON.parse(String(r.state)));
  } catch {
    /* malformed stored state → empty (never throw on read) */
  }
  return {
    id: String(r.id),
    name: String(r.name),
    state,
    createdBy: r.created_by == null ? null : String(r.created_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** All saved views, most-recently-updated first. */
export function listFinanceSavedViews(): SavedViewRow[] {
  return (getDb().prepare("SELECT * FROM finance_saved_views ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(rowToView);
}

/**
 * Create or update (upsert) a saved view, keyed by its name (case-insensitive). Returns the stored row,
 * or null when the name is invalid. Idempotent: saving the same name twice updates it, never duplicates.
 */
export function saveFinanceSavedView(
  input: { name: unknown; state: unknown; actor?: string | null },
  now: Date = new Date(),
): SavedViewRow | null {
  const name = normalizeViewName(input.name);
  if (!name) return null;
  const state = sanitizeViewState(input.state);
  const ts = now.toISOString();
  const db = getDb();
  // INSERT OR, on a name collision (NOCASE), UPDATE in place — keeping the original id/created_at/created_by.
  db.prepare(
    `INSERT INTO finance_saved_views (id, name, state, created_by, created_at, updated_at)
     VALUES (@id, @name, @state, @createdBy, @now, @now)
     ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  ).run({ id: `FSV-${randomUUID()}`, name, state: JSON.stringify(state), createdBy: input.actor ?? null, now: ts });
  const row = db.prepare("SELECT * FROM finance_saved_views WHERE name = ?").get(name) as Record<string, unknown> | undefined;
  return row ? rowToView(row) : null;
}

/** Delete a saved view by id (preferred) or name (case-insensitive). Returns true when a row was removed. */
export function deleteFinanceSavedView(sel: { id?: string | null; name?: string | null }): boolean {
  const db = getDb();
  if (sel.id) {
    return db.prepare("DELETE FROM finance_saved_views WHERE id = ?").run(sel.id).changes > 0;
  }
  const name = normalizeViewName(sel.name);
  if (!name) return false;
  return db.prepare("DELETE FROM finance_saved_views WHERE name = ?").run(name).changes > 0;
}
