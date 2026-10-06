"use client";

// AI Command Center — the control room for every AI employee and session across Zoe Operations. Answers
// "what are my AI employees doing right now?" Dominant ACTIVE SESSIONS as operational job cards (never
// chat bubbles), a five-state summary, and a right control rail (needs attention / pending approvals /
// recently completed). Renders the server snapshot, then polls /api/ai/sessions so it stays live. No fake
// sessions: an empty roster shows an intentional empty state.

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, CirclePlus, Radio, ShieldCheck, CheckCircle2, AlertTriangle, PauseCircle, History, ArrowRight, Bot } from "lucide-react";
import type { AiSessionCard } from "@/lib/ai/sessions";
import type { AiCommandOverview } from "@/lib/ai/control";
import { STATUS_META } from "@/lib/ai/sessionDisplay";

const POLL_MS = 12_000;

type FilterKey = "all" | "active" | "waiting" | "needs_approval" | "completed" | "errors";
const FILTERS: { key: FilterKey; label: string; match: (s: AiSessionCard["status"]) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "active", label: "Active", match: (s) => s === "running" },
  { key: "waiting", label: "Waiting", match: (s) => s === "paused" },
  { key: "needs_approval", label: "Needs approval", match: (s) => s === "awaiting_approval" },
  { key: "completed", label: "Completed", match: (s) => s === "done" || s === "cancelled" },
  { key: "errors", label: "Errors", match: (s) => s === "failed" },
];

function ago(iso: string | null): string {
  if (!iso) return "—";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(m)) return "—";
  if (m < 1) return "just now"; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

interface AgentRef { id: string; name: string; blade: string | null }
interface Playbook { id: string; label: string; endpoint: string; blade: string }

export function AiCommandConsole({
  initial, agents, nameById, canOperate, canApprove, initialBlade, today, playbooks = [],
}: {
  initial: AiCommandOverview;
  agents: AgentRef[];
  nameById: Record<string, string>;
  canOperate: boolean;
  canApprove: boolean;
  initialBlade?: string;
  today: string;
  playbooks?: Playbook[];
}): React.JSX.Element {
  const router = useRouter();
  const [cards, setCards] = useState(initial.cards);
  const [filter, setFilter] = useState<FilterKey>(initialBlade ? "all" : "all");
  const [blade, setBlade] = useState(initialBlade && agents.some((a) => a.blade === initialBlade) ? initialBlade : "");
  const [owner, setOwner] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/ai/sessions", { cache: "no-store" });
      if (r.ok) setCards(((await r.json()) as { sessions: AiSessionCard[] }).sessions);
    } catch { /* keep */ } finally { setRefreshing(false); }
  }, []);
  useEffect(() => { const id = setInterval(refresh, POLL_MS); return () => clearInterval(id); }, [refresh]);

  const startSession = useCallback(async (endpoint?: string) => {
    if (!endpoint && !agentId) return;
    setStarting(true);
    try {
      const r = await fetch(endpoint ?? "/api/ai/sessions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: endpoint ? "{}" : JSON.stringify({ agentId }),
      });
      if (r.ok) {
        const j = (await r.json()) as { session?: { id: string } };
        if (j.session) { router.push(`/ai-command/${j.session.id}`); return; }
        await refresh();
      }
    } finally { setStarting(false); }
  }, [agentId, refresh, router]);

  const owners = useMemo(() => [...new Set(cards.map((c) => c.owner).filter((x): x is string => !!x))].sort(), [cards]);
  const blades = useMemo(() => [...new Set(cards.map((c) => c.blade).filter((x): x is string => !!x))].sort(), [cards]);
  const counts = useMemo(() => ({
    active: cards.filter((c) => c.status === "running").length,
    waiting: cards.filter((c) => c.status === "paused").length,
    needsApproval: cards.filter((c) => c.status === "awaiting_approval").length,
    errors: cards.filter((c) => c.status === "failed").length,
    completedToday: cards.filter((c) => c.status === "done" && (c.endedAt ?? "").slice(0, 10) === today).length,
  }), [cards, today]);

  const matchFn = FILTERS.find((f) => f.key === filter)!.match;
  const visible = cards.filter((c) => matchFn(c.status) && (!blade || c.blade === blade) && (!owner || c.owner === owner));
  const recentlyCompleted = cards.filter((c) => c.status === "done").slice(0, 6);
  const noSessions = cards.length === 0;

  // New-session control (shared by the toolbar and the empty state).
  const newSession = (
    <div className="flex flex-wrap items-center gap-2">
      <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="rounded border border-border bg-[var(--panel)] px-2 py-1 text-[12.5px] text-secondary-text">
        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.blade ? ` · ${a.blade}` : ""}</option>)}
      </select>
      <button onClick={() => startSession()} disabled={starting || !agentId} className="inline-flex items-center gap-1.5 border border-[var(--gold)]/50 px-2.5 py-1 text-[12.5px] font-medium text-[var(--gold)] transition-colors hover:bg-[var(--gold)]/10 disabled:opacity-50">
        {starting ? <Loader2 className="size-3.5 animate-spin" /> : <CirclePlus className="size-3.5" />} Create session
      </button>
      {playbooks.map((pb) => (
        <button key={pb.id} onClick={() => startSession(pb.endpoint)} disabled={starting} title={`${pb.blade} playbook`} className="inline-flex items-center gap-1.5 border border-border px-2.5 py-1 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50">
          {starting ? <Loader2 className="size-3.5 animate-spin" /> : <Radio className="size-3.5" />} {pb.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Five-state summary */}
      <div className="grid grid-cols-2 divide-border border border-border bg-panel sm:grid-cols-3 sm:divide-x lg:grid-cols-5 [&>*]:border-t [&>*]:border-border sm:[&>*]:border-t-0 sm:[&>*:nth-child(-n+3)]:border-t-0 lg:[&>*]:border-t-0">
        <Summary label="Active" value={counts.active} tone={counts.active ? "positive" : "default"} onClick={() => setFilter("active")} active={filter === "active"} />
        <Summary label="Waiting" value={counts.waiting} tone={counts.waiting ? "tertiary" : "default"} onClick={() => setFilter("waiting")} active={filter === "waiting"} />
        <Summary label="Needs approval" value={counts.needsApproval} tone={counts.needsApproval ? "attention" : "default"} onClick={() => setFilter("needs_approval")} active={filter === "needs_approval"} />
        <Summary label="Errors" value={counts.errors} tone={counts.errors ? "critical" : "default"} onClick={() => setFilter("errors")} active={filter === "errors"} />
        <Summary label="Completed today" value={counts.completedToday} tone="default" onClick={() => setFilter("completed")} active={filter === "completed"} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* PRIMARY — active sessions as operational job cards */}
        <div className="space-y-3 lg:col-span-8">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-2.5">
            <div className="flex flex-wrap items-center gap-4">
              {FILTERS.map((f) => (
                <button key={f.key} onClick={() => setFilter(f.key)} className={`text-[13px] transition-colors ${filter === f.key ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{f.label}</button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <select value={blade} onChange={(e) => setBlade(e.target.value)} className="rounded border border-border bg-[var(--panel)] px-2 py-1 text-[12px] text-secondary-text"><option value="">All blades</option>{blades.map((b) => <option key={b} value={b}>{b}</option>)}</select>
              <select value={owner} onChange={(e) => setOwner(e.target.value)} className="rounded border border-border bg-[var(--panel)] px-2 py-1 text-[12px] text-secondary-text"><option value="">All owners</option>{owners.map((o) => <option key={o} value={o}>{o}</option>)}</select>
              <span className="inline-flex items-center gap-1 text-[11px] text-meta">{refreshing ? <Loader2 className="size-3 animate-spin" /> : <Radio className="size-3" />} live</span>
            </div>
          </div>

          {canOperate && !noSessions && <div className="border border-border bg-panel p-2.5">{newSession}</div>}

          {noSessions ? (
            <div className="flex flex-col items-center gap-3 border border-dashed border-border bg-panel px-6 py-14 text-center">
              <Bot className="size-7 text-meta" />
              <div>
                <div className="text-[15px] font-semibold text-foreground">No active AI sessions</div>
                <div className="mt-1 text-[12.5px] text-meta">Start an AI session from any blade, or run a playbook below. Real sessions appear here automatically.</div>
              </div>
              {canOperate && <div className="mt-1">{newSession}</div>}
            </div>
          ) : visible.length === 0 ? (
            <p className="border border-border bg-panel p-4 text-[13px] text-meta">No sessions match this filter.</p>
          ) : (
            <div className="space-y-2.5">
              {visible.map((c) => <JobCard key={c.id} card={c} agentName={nameById[c.agentId] ?? c.agentId} />)}
            </div>
          )}
        </div>

        {/* RIGHT — control rail */}
        <div className="space-y-4 lg:col-span-4">
          <Rail title="Needs attention" icon={<AlertTriangle className="size-4" />}>
            {counts.needsApproval + counts.waiting + counts.errors + initial.pendingApprovals.length === 0 ? (
              <p className="text-[12.5px] text-positive">Nothing needs you right now.</p>
            ) : (
              <ul className="space-y-1.5 text-[12.5px]">
                {initial.pendingApprovals.length > 0 && <Attn icon={<ShieldCheck className="size-3.5 text-attention" />} text={`${initial.pendingApprovals.length} action${initial.pendingApprovals.length === 1 ? "" : "s"} need approval`} />}
                {counts.waiting > 0 && <Attn icon={<PauseCircle className="size-3.5 text-tertiary-text" />} text={`${counts.waiting} session${counts.waiting === 1 ? "" : "s"} waiting`} />}
                {counts.errors > 0 && <Attn icon={<AlertTriangle className="size-3.5 text-critical" />} text={`${counts.errors} session error${counts.errors === 1 ? "" : "s"}`} />}
              </ul>
            )}
          </Rail>

          <Rail title="Pending approvals" icon={<ShieldCheck className="size-4" />}>
            {initial.pendingApprovals.length === 0 ? (
              <p className="text-[12.5px] text-meta">No actions awaiting approval.</p>
            ) : (
              <div className="space-y-2">
                {initial.pendingApprovals.slice(0, 6).map((a) => (
                  <div key={a.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-foreground">{a.title}</span>
                      <span className="block truncate text-[11px] text-meta">{a.agentName}{a.financial ? " · $" : ""}</span>
                    </span>
                    {canApprove && (
                      <Link href={a.sessionId ? `/ai-command/${a.sessionId}` : "/ai-org/approvals"} className="shrink-0 rounded border border-[var(--gold)]/50 px-2 py-0.5 text-[11px] font-medium text-[var(--gold)] transition-colors hover:bg-[var(--gold)]/10">Review</Link>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Rail>

          <Rail title="Recently completed" icon={<CheckCircle2 className="size-4" />} action={<button onClick={() => setFilter("completed")} className="inline-flex items-center gap-0.5 text-[11px] text-meta transition-colors hover:text-foreground"><History className="size-3" /> View history</button>}>
            {recentlyCompleted.length === 0 ? (
              <p className="text-[12.5px] text-meta">Nothing completed yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {recentlyCompleted.map((c) => (
                  <li key={c.id}>
                    <Link href={`/ai-command/${c.id}`} className="flex items-center gap-2 text-[12.5px] transition-colors hover:text-foreground">
                      <CheckCircle2 className="size-3.5 shrink-0 text-positive" />
                      <span className="min-w-0 flex-1 truncate text-secondary-text">{c.title}</span>
                      <span className="shrink-0 text-[10.5px] text-meta">{ago(c.endedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Rail>
        </div>
      </div>
    </div>
  );
}

function JobCard({ card, agentName }: { card: AiSessionCard; agentName: string }): React.JSX.Element {
  const m = STATUS_META[card.status];
  return (
    <div className="surface border p-3.5">
      <div className="flex items-start gap-2.5">
        <span className={`mt-1 size-2 shrink-0 rounded-full ${m.dot}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold uppercase tracking-[0.02em] text-foreground">{agentName}</span>
            <span className={`ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide ${m.text}`}>{m.label}</span>
          </div>
          <div className="mt-0.5 text-[12px] text-meta">
            {card.blade ? <span className="text-tertiary-text">{card.blade}</span> : "cross-blade"} · {card.title}
          </div>
          {card.objective && (
            <div className="mt-2">
              <span className="text-[9.5px] uppercase tracking-[0.1em] text-meta">Objective</span>
              <p className="text-[12.5px] text-secondary-text">{card.objective}</p>
            </div>
          )}
          {card.lastActivity && <p className="mt-2 border-l-2 border-[var(--row-rule)] pl-2.5 text-[12.5px] text-tertiary-text">{card.lastActivity}</p>}
          <div className="mt-2.5 flex items-center gap-3 text-[11px] text-meta">
            <span>Last activity: {ago(card.updatedAt)}</span>
            {card.owner && <span>· {card.owner}</span>}
            <Link href={`/ai-command/${card.id}`} className="ml-auto inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">Open session <ArrowRight className="size-3" /></Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Summary({ label, value, tone, onClick, active }: { label: string; value: number; tone: "default" | "positive" | "attention" | "critical" | "tertiary"; onClick: () => void; active: boolean }): React.JSX.Element {
  const t = tone === "positive" ? "text-positive" : tone === "attention" ? "text-attention" : tone === "critical" ? "text-critical" : tone === "tertiary" ? "text-tertiary-text" : "text-foreground";
  return (
    <button onClick={onClick} className={`min-w-0 p-3 text-left transition-colors hover:bg-[var(--row-hover)] ${active ? "bg-[var(--row-hover)]" : ""}`}>
      <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-meta">{label}</div>
      <div className={`text-[24px] font-semibold leading-none tabular-nums ${t}`}>{value}</div>
    </button>
  );
}

function Rail({ title, icon, children, action }: { title: string; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }): React.JSX.Element {
  return (
    <section className="surface border p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">{icon} {title}</h2>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

function Attn({ icon, text }: { icon: React.ReactNode; text: string }): React.JSX.Element {
  return <li className="flex items-center gap-2 text-secondary-text">{icon} {text}</li>;
}
