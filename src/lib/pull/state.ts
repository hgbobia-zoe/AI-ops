// Pull freshness + import ledger. Freshness is tracked PER SOURCE (route:<truck>, bookings,
// revenue) so a bookings pull can't mask stale routes. The import_log records every attempt (counts
// + errors) — the factual basis for the Data Health view and for detecting a bad-but-recent pull.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

const KEY = "pull_state";

export interface SourceFreshness {
  at: string; // ISO of the last successful pull for this source
  count: number;
}

export interface PullState {
  sources?: Record<string, SourceFreshness>;
  lastStaleAlertAt?: string;
  // Legacy single-value fields (kept so the existing freshness banner keeps working).
  lastPullAt?: string;
  lastStops?: number;
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

/** Record a SUCCESSFUL pull for one source (e.g. "route:E450", "bookings"). */
export function recordPull(source: string, count: number, now: Date = new Date()): void {
  const s = getPullState();
  s.sources = s.sources ?? {};
  s.sources[source] = { at: now.toISOString(), count };
  s.lastPullAt = now.toISOString();
  s.lastStops = count;
  save(s);
}

export function markStaleAlerted(now: Date = new Date()): void {
  const s = getPullState();
  s.lastStaleAlertAt = now.toISOString();
  save(s);
}

// ── Import ledger ────────────────────────────────────────────────────────────

export interface ImportMeta {
  rowsIn?: number;
  rowsWritten?: number;
  rowsSkipped?: number;
  detail?: string;
}

/** Append one import/pull attempt to the ledger. ok=false for a failed OR partial import. */
export function logImport(source: string, ok: boolean, m: ImportMeta = {}, now: Date = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO import_log (id, ts, source, ok, rows_in, rows_written, rows_skipped, detail)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(`IL-${randomUUID()}`, now.toISOString(), source, ok ? 1 : 0, m.rowsIn ?? null, m.rowsWritten ?? null, m.rowsSkipped ?? null, m.detail ?? null);
}

export interface ImportRow {
  id: string;
  ts: string;
  source: string;
  ok: boolean;
  rowsIn: number | null;
  rowsWritten: number | null;
  rowsSkipped: number | null;
  detail: string | null;
}

export function getRecentImports(limit = 100): ImportRow[] {
  return (getDb().prepare("SELECT * FROM import_log ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    ts: String(r.ts),
    source: String(r.source),
    ok: Number(r.ok) === 1,
    rowsIn: r.rows_in == null ? null : Number(r.rows_in),
    rowsWritten: r.rows_written == null ? null : Number(r.rows_written),
    rowsSkipped: r.rows_skipped == null ? null : Number(r.rows_skipped),
    detail: (r.detail as string) ?? null,
  }));
}

/** Latest import row per source (for the health view). */
export function getLatestImportBySource(): Record<string, ImportRow> {
  const rows = getRecentImports(500);
  const out: Record<string, ImportRow> = {};
  for (const r of rows) if (!out[r.source]) out[r.source] = r;
  return out;
}
