"use client";

// AI Command Center — the mission-control view over AI sessions. Dense, dark, status-first (Grafana/Jira
// idiom, not a chat UI). Renders the server's initial snapshot, then polls /api/ai/sessions so the feed
// and live counts update on their own (the established AutoRefresh/poll pattern; no SSE in this app).

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Activity, CircleDot, Loader2, Cpu, Plug, Radio, ShieldCheck } from "lucide-react";
import type { AiSession, SessionStatus } from "@/lib/ai/sessions";
import type { AiControlOverview } from "@/lib/ai/control";

const POLL_MS = 15_000;

const STATUS_DOT: Record<SessionStatus, string> = {
  running: "text-positive",
  awaiting_approval: "text-attention",
  done: "text-meta",
  failed: "text-critical",
  cancelled: "text-meta",
};
const STATUS_CHIP: Record<SessionStatus, string> = {
  running: "border-positive/40 text-positive",
  awaiting_approval: "border-attention/50 text-attention",
  done: "border-border text-meta",
  failed: "border-critical/50 text-critical",
  cancelled: "border-border text-meta",
};
const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "Running",
  awaiting_approval: "Awaiting approval",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

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

interface AgentRef { id: string; name: string; blade: string | null }

export function AiSessionsConsole({
  initial,
  agents,
  nameById,
  canOperate,
}: {
  initial: AiControlOverview;
  agents: AgentRef[];
  nameById: Record<string, string>;
  canOperate: boolean;
}): React.JSX.Element {
  const [overview, setOverview] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/ai/sessions", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { sessions: AiSession[] };
        setOverview((o) => ({
          ...o,
          recent: j.sessions,
          liveCount: j.sessions.filter((s) => s.status === "running" || s.status === "awaiting_approval").length,
        }));
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

  const startSession = useCallback(async () => {
    if (!agentId) return;
    setStarting(true);
    try {
      const r = await fetch("/api/ai/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      if (r.ok) await refresh();
    } catch {
      /* ignore */
    } finally {
      setStarting(false);
    }
  }, [agentId, refresh]);

  const p = overview.provider;

  return (
    <div className="space-y-6">
      {/* Mission-control status strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<Radio className="size-4" />} label="Live sessions" value={overview.liveCount} tone={overview.liveCount > 0 ? "positive" : "default"} />
        <StatCard icon={<ShieldCheck className="size-4" />} label="Pending approvals" value={overview.pendingApprovals} tone={overview.pendingApprovals > 0 ? "attention" : "default"} />
        <StatCard
          icon={<Cpu className="size-4" />}
          label="AI provider"
          value={p.activeName}
          sub={p.mode === "inline" ? (p.inlineReady ? "inline · ready" : "inline · not keyed") : "deferred"}
          tone={p.mode === "inline" && p.inlineReady ? "positive" : "default"}
        />
        <StatCard
          icon={<Plug className="size-4" />}
          label="Session bridge"
          value={p.bridgeConnected ? "Connected" : "Not connected"}
          tone={p.bridgeConnected ? "positive" : "default"}
        />
      </div>

      {/* Start a session (operate) */}
      {canOperate && agents.length > 0 && (
        <div className="surface flex flex-wrap items-center gap-2 border p-3">
          <span className="text-[12px] uppercase tracking-[0.07em] text-meta">Start a session</span>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="rounded border border-border bg-[var(--panel)] px-2 py-1 text-sm text-foreground"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.blade ? ` · ${a.blade}` : ""}
              </option>
            ))}
          </select>
          <button
            onClick={startSession}
            disabled={starting || !agentId}
            className="flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
          >
            {starting ? <Loader2 className="size-3.5 animate-spin" /> : <CircleDot className="size-3.5" />} Open session
          </button>
        </div>
      )}

      {/* Session feed */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.06em] text-tertiary-text">
            <Activity className="size-4" /> Recent sessions
          </h2>
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-meta">
            {refreshing ? <Loader2 className="size-3 animate-spin" /> : null} auto-refresh
          </span>
        </div>
        {overview.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AI sessions yet. Start one above, or an agent opens one when it runs.</p>
        ) : (
          <div className="overflow-x-auto border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-rule text-left text-[11px] uppercase tracking-[0.06em] text-meta">
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 font-medium">Title</th>
                  <th className="px-3 py-2 font-medium">Blade</th>
                  <th className="px-3 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {overview.recent.map((s) => (
                  <tr key={s.id} className="border-b border-rule transition-colors hover:bg-[var(--row-hover)]">
                    <td className="px-3 py-2">
                      <Link href={`/ai-org/sessions/${s.id}`} className="inline-flex items-center gap-1.5">
                        <CircleDot className={`size-3 ${STATUS_DOT[s.status]}`} />
                        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_CHIP[s.status]}`}>
                          {STATUS_LABEL[s.status]}
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-secondary-text">{nameById[s.agentId] ?? s.agentId}</td>
                    <td className="px-3 py-2">
                      <Link href={`/ai-org/sessions/${s.id}`} className="text-foreground hover:underline">
                        {s.title}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-[12px] text-meta">{s.blade ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums text-meta">{ago(s.createdAt)}</td>
                    <td className="px-3 py-2 tabular-nums text-meta">{ago(s.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  tone?: "default" | "positive" | "attention" | "critical";
}): React.JSX.Element {
  const toneCls =
    tone === "positive" ? "text-positive" : tone === "attention" ? "text-attention" : tone === "critical" ? "text-critical" : "text-foreground";
  return (
    <div className="surface flex flex-col gap-1 border p-3">
      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.07em] text-meta">{icon} {label}</span>
      <span className={`text-lg font-semibold ${toneCls}`}>{value}</span>
      {sub && <span className="text-[11px] text-meta">{sub}</span>}
    </div>
  );
}
