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

export type AgentStatus = "ok" | "no_tab" | "not_logged_in" | "error";

export interface AgentHeartbeat {
  agent: string; // e.g. "extension"
  status: AgentStatus;
  detail: string | null;
  at: string; // ISO of this heartbeat
}

export interface PullState {
  sources?: Record<string, SourceFreshness>;
  lastStaleAlertAt?: string;
  agent?: AgentHeartbeat; // last heartbeat from the Auto-Pull extension (drives the "not signed in" banner)
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

/** Record the Auto-Pull extension's latest heartbeat (status + detail). Independent of pull success —
 *  a successful pull updates source freshness via recordPull; this captures WHY a pull didn't happen
 *  (no GSPRO tab, signed out) so the UI can say so precisely instead of only "stale". */
export function recordAgentHeartbeat(agent: string, status: AgentStatus, detail: string | null, now: Date = new Date()): void {
  const s = getPullState();
  s.agent = { agent, status, detail: detail ?? null, at: now.toISOString() };
  save(s);
}

// ── Banner verdict (drives PullHealthBanner) ──────────────────────────────────

export interface PullBanner {
  level: "error" | "warn";
  title: string;
  detail: string;
}

/** Decide whether to show a data-health banner, and what it says. Keys primarily off the Auto-Pull
 *  extension's heartbeat (it pings every cycle): a recent "not_logged_in"/"no_tab"/"error" is precise;
 *  a missing/stale heartbeat means the puller isn't running at all. Returns null when all is well.
 *  `agentFreshMin` = how recent a heartbeat must be to be trusted (default 30m; the extension pulls
 *  every ~10m). `routeStaleH` = fallback route-freshness threshold when there's no extension at all. */
export function pullBannerState(now: number = Date.now(), agentFreshMin = 30, routeStaleH = 20): PullBanner | null {
  const st = getPullState();
  const agent = st.agent;
  const agentAgeMin = agent ? (now - Date.parse(agent.at)) / 60000 : Infinity;

  const routeAts = Object.entries(st.sources ?? {})
    .filter(([k]) => k.startsWith("route:"))
    .map(([, v]) => Date.parse(v.at))
    .filter((t) => !Number.isNaN(t));
  const lastRouteAt = routeAts.length ? Math.max(...routeAts) : NaN;
  const routeAgeH = routeAts.length ? (now - lastRouteAt) / 3_600_000 : Infinity;
  const routeAgeMin = routeAgeH * 60;
  const lastPullPhrase = routeAts.length ? `Last route pull ${Math.round(routeAgeH)}h ago.` : "Routes have never been pulled.";

  // A live extension heartbeat is the most precise signal.
  if (agent && agentAgeMin <= agentFreshMin) {
    if (agent.status === "not_logged_in")
      return { level: "error", title: "Goodshuffle is signed out — auto-pull can't run", detail: "Open pro.goodshuffle.com on the office machine and sign in; data will refresh within a few minutes." };
    if (agent.status === "no_tab")
      return { level: "warn", title: "Auto-pull has no Goodshuffle tab open", detail: "Open pro.goodshuffle.com (signed in) in the office browser so the pull can run." };
    if (agent.status === "error") {
      // A transient/partial error is RESOLVED once a successful route pull lands. If routes are fresh
      // (a good pull within the freshness window), the data is current — don't alarm over a stale error
      // heartbeat. The banner returns only while routes are ALSO stale (a real, unresolved problem).
      if (routeAgeMin <= agentFreshMin) return null;
      return { level: "warn", title: "Auto-pull hit a problem", detail: `${agent.detail ?? "Last pull errored."} ${lastPullPhrase}` };
    }
    return null; // status ok and recent → all good
  }

  // No live heartbeat. If a route pull is recent enough anyway (manual bookmarklet), stay quiet.
  if (routeAgeH < routeStaleH) return null;
  return {
    level: "warn",
    title: "Route data may be stale — auto-pull isn't reporting in",
    detail: `${lastPullPhrase} Start the Auto-Pull extension (or run the pull) on the office machine.`,
  };
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
