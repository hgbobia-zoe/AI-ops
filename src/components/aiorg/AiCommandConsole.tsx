"use client";

// AI Command Center — mission control over every AI session across the platform. Status-first, dense,
// Grafana/Jira idiom (not a chat UI). A stat strip, a status filter rail, blade + owner filters, and a
// dense list of sessions. Renders the server snapshot, then polls /api/ai/sessions so the feed stays live.

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Cpu, Plug, Radio, ShieldCheck, ChevronRight, CirclePlus, Boxes, Activity } from "lucide-react";
import type { AiSession, SessionStatus } from "@/lib/ai/sessions";
import type { AiControlOverview } from "@/lib/ai/control";
import { STATUS_META } from "@/lib/ai/sessionDisplay";

const POLL_MS = 15_000;

type FilterKey = "all" | "active" | "waiting" | "needs_approval" | "completed" | "errors";
const FILTERS: { key: FilterKey; label: string; match: (s: SessionStatus) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "active", label: "Active", match: (s) => s === "running" },
  { key: "waiting", label: "Waiting", match: (s) => s === "paused" },
  { key: "needs_approval", label: "Needs approval", match: (s) => s === "awaiting_approval" },
  { key: "completed", label: "Completed", match: (s) => s === "done" || s === "cancelled" },
  { key: "errors", label: "Errors", match: (s) => s === "failed" },
];

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

interface Playbook { id: string; label: string; endpoint: string; blade: string }

export function AiCommandConsole({
  initial,
  sessions: initialSessions,
  agents,
  nameById,
  canOperate,
  initialBlade,
  playbooks = [],
}: {
  initial: AiControlOverview;
  sessions: AiSession[];
  agents: AgentRef[];
  nameById: Record<string, string>;
  canOperate: boolean;
  initialBlade?: string;
  playbooks?: Playbook[];
}): React.JSX.Element {
  const router = useRouter();
  const [overview, setOverview] = useState(initial);
  const [sessions, setSessions] = useState(initialSessions);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [blade, setBlade] = useState<string>(initialBlade && agents.some((a) => a.blade === initialBlade) ? initialBlade : "");
  const [owner, setOwner] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/ai/sessions", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { sessions: AiSession[] };
        setSessions(j.sessions);
        setOverview((o) => ({
          ...o,
          liveCount: j.sessions.filter((x) => x.status === "running" || x.status === "awaiting_approval" || x.status === "paused").length,
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
      const r = await fetch("/api/ai/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId }) });
      if (r.ok) {
        const j = (await r.json()) as { session?: AiSession };
        if (j.session) {
          router.push(`/ai-command/${j.session.id}`);
          return;
        }
        await refresh();
      }
    } finally {
      setStarting(false);
    }
  }, [agentId, refresh, router]);

  const runPlaybook = useCallback(async (pb: Playbook) => {
    setStarting(true);
    try {
      const r = await fetch(pb.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (r.ok) {
        const j = (await r.json()) as { session?: AiSession };
        if (j.session) { router.push(`/ai-command/${j.session.id}`); return; }
        await refresh();
      }
    } finally {
      setStarting(false);
    }
  }, [refresh, router]);

  const owners = useMemo(() => [...new Set(sessions.map((s) => s.owner).filter((x): x is string => !!x))].sort(), [sessions]);
  const blades = useMemo(() => [...new Set(sessions.map((s) => s.blade).filter((x): x is string => !!x))].sort(), [sessions]);
  const counts = useMemo(() => {
    const out = {} as Record<FilterKey, number>;
    for (const f of FILTERS) out[f.key] = sessions.filter((s) => f.match(s.status)).length;
    return out;
  }, [sessions]);

  const matchFn = FILTERS.find((f) => f.key === filter)!.match;
  const visible = sessions.filter((s) => matchFn(s.status) && (!blade || s.blade === blade) && (!owner || s.owner === owner));

  const p = overview.provider;
  const needsApproval = sessions.filter((s) => s.status === "awaiting_approval").length;

  return (
    <div className="space-y-5">
      {/* Stat strip */}
      <div className="grid grid-cols-2 divide-border border border-border bg-panel sm:grid-cols-3 sm:divide-x lg:grid-cols-5 [&>*]:border-t [&>*]:border-border sm:[&>*]:border-t-0 sm:[&>*:nth-child(-n+3)]:border-t-0 lg:[&>*]:border-t-0">
        <Stat icon={<Radio className="size-3.5" />} label="Live sessions" value={overview.liveCount} tone={overview.liveCount > 0 ? "positive" : "default"} />
        <Stat icon={<ShieldCheck className="size-3.5" />} label="Needs approval" value={needsApproval} tone={needsApproval > 0 ? "attention" : "default"} />
        <Stat icon={<ShieldCheck className="size-3.5" />} label="Pending approvals" value={overview.pendingApprovals} tone={overview.pendingApprovals > 0 ? "attention" : "default"} />
        <Stat icon={<Cpu className="size-3.5" />} label="Provider" value={p.activeName} sub={p.mode === "inline" ? (p.inlineReady ? "inline · ready" : "inline · not keyed") : "deferred"} small />
        <Stat icon={<Plug className="size-3.5" />} label="Session bridge" value={p.bridgeConnected ? "Connected" : "Not connected"} tone={p.bridgeConnected ? "positive" : "default"} small />
      </div>

      {/* Controls: filter rail + blade/owner + new session */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-border pb-2.5">
        <div className="flex flex-wrap items-center gap-4">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`inline-flex items-center gap-1.5 text-[13px] transition-colors ${filter === f.key ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {f.label}
              <span className={`rounded px-1 py-0.5 text-[10px] tabular-nums ${filter === f.key ? "bg-foreground/10 text-foreground" : "text-meta"}`}>{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select value={blade} onChange={(e) => setBlade(e.target.value)} className="rounded border border-border bg-[var(--panel)] px-2 py-1 text-[12.5px] text-secondary-text">
            <option value="">All blades</option>
            {blades.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className="rounded border border-border bg-[var(--panel)] px-2 py-1 text-[12.5px] text-secondary-text">
            <option value="">All owners</option>
            {owners.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <span className="inline-flex items-center gap-1 text-[11px] text-meta">{refreshing ? <Loader2 className="size-3 animate-spin" /> : <Activity className="size-3" />} live</span>
        </div>
      </div>

      {/* New session */}
      {canOperate && agents.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border border-border bg-panel p-2.5">
          <span className="text-[11px] uppercase tracking-[0.08em] text-meta">New AI session</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="rounded border border-border bg-[var(--panel)] px-2 py-1 text-[12.5px] text-secondary-text">
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.blade ? ` · ${a.blade}` : ""}</option>)}
          </select>
          <button onClick={startSession} disabled={starting || !agentId} className="inline-flex items-center gap-1.5 border border-attention/50 px-2.5 py-1 text-[12.5px] font-medium text-attention transition-colors hover:bg-attention/10 disabled:opacity-50">
            {starting ? <Loader2 className="size-3.5 animate-spin" /> : <CirclePlus className="size-3.5" />} Open session
          </button>
          {playbooks.length > 0 && <span className="mx-1 text-[11px] text-meta">or run a playbook</span>}
          {playbooks.map((pb) => (
            <button key={pb.id} onClick={() => runPlaybook(pb)} disabled={starting} className="inline-flex items-center gap-1.5 border border-border px-2.5 py-1 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50" title={`${pb.blade} playbook`}>
              {starting ? <Loader2 className="size-3.5 animate-spin" /> : <Radio className="size-3.5" />} {pb.label}
            </button>
          ))}
        </div>
      )}

      {/* Session list */}
      {visible.length === 0 ? (
        <p className="border border-border bg-panel p-4 text-[13px] text-meta">No sessions match this filter. {sessions.length === 0 ? "Start one above, or an agent opens one when it runs." : ""}</p>
      ) : (
        <div className="divide-y divide-[var(--row-rule)] border border-border">
          {visible.map((s) => {
            const m = STATUS_META[s.status];
            return (
              <Link key={s.id} href={`/ai-command/${s.id}`} className="flex items-center gap-3 bg-panel px-3.5 py-3 transition-colors hover:bg-[var(--row-hover)]">
                <span className={`size-2 shrink-0 rounded-full ${m.dot}`} aria-hidden />
                <span className="flex size-8 shrink-0 items-center justify-center border border-border text-meta"><Boxes className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-medium text-foreground">{s.title}</span>
                    {s.blade && <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-meta">{s.blade}</span>}
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
                    {nameById[s.agentId] ?? s.agentId}
                    {s.owner ? ` · ${s.owner}` : ""}
                    {s.objective ? ` · ${s.objective}` : s.status === "failed" && s.error ? ` · ${s.error}` : ""}
                  </span>
                </span>
                <span className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
                  <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${m.text}`}>{m.label}</span>
                  <span className="text-[10.5px] text-meta">{ago(s.updatedAt)}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-meta" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ icon, label, value, sub, tone = "default", small }: { icon: React.ReactNode; label: string; value: string | number; sub?: string; tone?: "default" | "positive" | "attention"; small?: boolean }): React.JSX.Element {
  const toneCls = tone === "positive" ? "text-positive" : tone === "attention" ? "text-attention" : "text-foreground";
  return (
    <div className="min-w-0 p-3">
      <div className="mb-1 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-meta">{icon} {label}</div>
      <div className={`truncate font-semibold tabular-nums ${small ? "text-[15px]" : "text-[22px] leading-none"} ${toneCls}`}>{value}</div>
      {sub && <div className="mt-1 truncate text-[11px] text-meta">{sub}</div>}
    </div>
  );
}
