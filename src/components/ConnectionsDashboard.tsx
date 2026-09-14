"use client";

// The Connections dashboard: one status card per integration (green = OK, amber = needs attention,
// grey = not connected), a live Refresh, per-connection Test where the provider supports it, and a
// status-page-style uptime strip of recent imports. Renders the server's initial snapshot, then polls
// /api/health so statuses (and the uptime bars) update on their own.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { RefreshCw, CheckCircle2, AlertTriangle, MinusCircle, Activity, Loader2, Plug } from "lucide-react";
import type { Connection, ConnectionsSummary, ConnStatus } from "@/lib/health/connections";
import type { ImportRow } from "@/lib/pull/state";

const POLL_MS = 30_000;

const DOT: Record<ConnStatus, string> = { ok: "text-emerald-400", attention: "text-amber-400", off: "text-muted-foreground" };
const CHIP: Record<ConnStatus, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  attention: "border-amber-500/50 bg-amber-500/10 text-amber-200",
  off: "border-white/15 bg-white/5 text-muted-foreground",
};
const CARD: Record<ConnStatus, string> = {
  ok: "border-white/10",
  attention: "border-amber-500/30 bg-amber-500/[0.03]",
  off: "border-white/10",
};
const STATUS_LABEL: Record<ConnStatus, string> = { ok: "Connected", attention: "Needs attention", off: "Not connected" };

function ago(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function when(iso: string): string {
  try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return iso; }
}

interface TestState { busy: boolean; ok?: boolean; msg?: string }

export function ConnectionsDashboard({
  initialConnections,
  initialSummary,
  initialImports,
}: {
  initialConnections: Connection[];
  initialSummary: ConnectionsSummary;
  initialImports: ImportRow[];
}): React.JSX.Element {
  const [conns, setConns] = useState(initialConnections);
  const [summary, setSummary] = useState(initialSummary);
  const [imports, setImports] = useState(initialImports);
  const [checkedAt, setCheckedAt] = useState<string>(new Date().toISOString());
  const [refreshing, setRefreshing] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { connections: Connection[]; summary: ConnectionsSummary; imports: ImportRow[]; at: string };
        setConns(j.connections);
        setSummary(j.summary);
        setImports(j.imports);
        setCheckedAt(j.at);
      }
    } catch {
      /* keep current */
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const runTest = useCallback(async (conn: Connection) => {
    if (!conn.test) return;
    setTests((t) => ({ ...t, [conn.key]: { busy: true } }));
    try {
      if (conn.test.kind === "gpstrackit") {
        // Real GPS TrackIt check: list units. Non-null means the key works and vehicles are visible.
        const r = await fetch("/api/eta/units", { cache: "no-store" });
        const j = (await r.json().catch(() => ({}))) as { units?: unknown };
        const ok = r.ok && j.units != null;
        setTests((t) => ({ ...t, [conn.key]: { busy: false, ok, msg: ok ? "GPS TrackIt OK" : "No units — check GPSTRACKIT_API_KEY" } }));
        if (ok) void refresh();
        return;
      }
      const r = await fetch("/api/integrations/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(conn.test) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      const msg = r.status === 401 ? "Needs admin PIN — test from Settings." : j.ok ? "Connection OK" : j.error || "Test failed";
      setTests((t) => ({ ...t, [conn.key]: { busy: false, ok: r.status !== 401 && !!j.ok, msg } }));
      if (j.ok) void refresh();
    } catch {
      setTests((t) => ({ ...t, [conn.key]: { busy: false, ok: false, msg: "Test error" } }));
    }
  }, [refresh]);

  return (
    <div className="space-y-8">
      {/* Summary + refresh */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="size-4 text-emerald-400" /> {summary.ok} connected</span>
          <span className="text-muted-foreground">·</span>
          <span className="inline-flex items-center gap-1.5"><AlertTriangle className="size-4 text-amber-400" /> {summary.attention} need attention</span>
          <span className="text-muted-foreground">·</span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground"><MinusCircle className="size-4" /> {summary.off} off</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">checked {ago(checkedAt)}</span>
          <button onClick={refresh} disabled={refreshing} className="flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50">
            {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Refresh
          </button>
        </div>
      </div>

      {/* Connection cards */}
      <div className="grid gap-3 sm:grid-cols-2">
        {conns.map((c) => {
          const t = tests[c.key];
          return (
            <div key={c.key} className={`surface flex flex-col gap-2 border p-4 ${CARD[c.status]}`}>
              <div className="flex items-center gap-2">
                <Plug className={`size-4 shrink-0 ${DOT[c.status]}`} />
                <span className="font-semibold">{c.label}</span>
                <span className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${CHIP[c.status]}`}>{STATUS_LABEL[c.status]}</span>
              </div>
              <div>
                <div className="text-sm font-medium">{c.headline}</div>
                <div className="text-[12px] text-muted-foreground">{c.detail}</div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">{c.category}{c.lastAt ? ` · ${ago(c.lastAt)}` : ""}</span>
                <div className="ml-auto flex items-center gap-2">
                  {t?.msg && <span className={t.ok ? "text-emerald-300" : "text-amber-300"}>{t.msg}</span>}
                  {c.test && (
                    <button onClick={() => runTest(c)} disabled={t?.busy} className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50">
                      {t?.busy ? <Loader2 className="size-3 animate-spin" /> : <Activity className="size-3" />} Test
                    </button>
                  )}
                  {c.fixHref && c.fixLabel && (
                    <Link href={c.fixHref} className="rounded border border-white/15 px-2 py-1 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground">{c.fixLabel} →</Link>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent imports — status-page uptime strip */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><Activity className="size-4" /> Import activity</h2>
        <ImportUptime imports={imports} />
      </section>
    </div>
  );
}

function ImportUptime({ imports }: { imports: ImportRow[] }): React.JSX.Element {
  if (imports.length === 0) return <p className="text-sm text-muted-foreground">No imports recorded yet.</p>;

  // Group by source, newest-first from the API; show up to 40 per source, oldest→newest left→right.
  const bySource = new Map<string, ImportRow[]>();
  for (const r of imports) {
    const arr = bySource.get(r.source) ?? [];
    if (arr.length < 40) arr.push(r);
    bySource.set(r.source, arr);
  }
  const rows = [...bySource.entries()]
    .map(([source, list]) => ({ source, list: [...list].reverse() })) // chronological
    .sort((a, b) => Date.parse(b.list[b.list.length - 1].ts) - Date.parse(a.list[a.list.length - 1].ts));

  return (
    <div className="space-y-3">
      {rows.map(({ source, list }) => {
        const okCount = list.filter((r) => r.ok).length;
        const pct = Math.round((okCount / list.length) * 100);
        const last = list[list.length - 1];
        return (
          <div key={source} className="border border-white/10 bg-white/[0.02] p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="font-mono text-[13px]">{source}</span>
              <span className={`text-[11px] tabular-nums ${pct === 100 ? "text-emerald-300" : pct >= 80 ? "text-amber-300" : "text-red-300"}`}>{pct}% ok · last {when(last.ts)}</span>
            </div>
            <div className="flex items-end gap-[3px]" role="img" aria-label={`${source}: ${pct}% successful over the last ${list.length} imports`}>
              {list.map((r) => (
                <span
                  key={r.id}
                  title={`${when(r.ts)} · ${r.ok ? "ok" : "failed/partial"}${r.detail ? ` · ${r.detail}` : ""}${r.rowsWritten != null ? ` · ${r.rowsWritten} written` : ""}`}
                  className={`h-7 w-[6px] shrink-0 rounded-sm ${r.ok ? "bg-emerald-500/70 hover:bg-emerald-400" : "bg-red-500/70 hover:bg-red-400"}`}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
