"use client";

// The board's side panel — the FULL lead in place, no page hop. Header + contact actions, the
// conversation feed (calls w/ summaries + texts + GS emails), and tabs: Next step (state + NBA + call/
// text/email briefs), Outreach (live draft), Details (priority + facts + activity), Ask (AI). The board
// stays interactive beside it, so a rep can click tile → tile. Read-only except the reused panels.

import { useCallback, useEffect, useState } from "react";
import { X, Phone, MessageSquare, Mail, ExternalLink, Sparkles, AlertTriangle, ListChecks, Search, RefreshCw } from "lucide-react";
import { ConversationFeed } from "@/components/ConversationFeed";
import { OutreachPanel } from "@/components/OutreachPanel";
import { LeadAsk } from "@/components/LeadAsk";
import { CopyButton } from "@/components/CopyButton";
import { QuoTextSend } from "@/components/QuoTextSend";
import type { TimelineItem } from "@/lib/coach/feedTypes";

interface FullLead {
  id: string;
  eventName: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  hasPhone: boolean;
  hasEmail: boolean;
  statusLabel: string;
  stageLabel: string;
  eventDate: string | null;
  eventWhen: string;
  value: number | null;
  gsUrl: string;
  state: { label: string; reason: string | null; evidence: string | null; confidence: number } | null;
  nba: { label: string; objective: string; doNot: string | null; reason: string | null } | null;
  brief: { blocker: string | null; opening: string; primaryQuestion: string; watchFor: string[]; textDraft: string; email: { subject: string; body: string } } | null;
  feed: TimelineItem[];
  priority: { score: number; factors: { label: string; points: number }[] };
  facts: { quoteCreated: string; quoteSent: string; eventDate: string; deposit: string | null };
  internalNotes: string | null;
  clientNotes: string | null;
  activity: { actor: string; actionLabel: string; ts: string; detail: string | null }[];
}

type Tab = "next" | "outreach" | "details" | "ask";
const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

export function LeadFullPanel({ id, viewer, onClose }: { id: string; viewer: { name: string; quoUserId: string | null; initials: string }; onClose: () => void }): React.JSX.Element {
  const [d, setD] = useState<FullLead | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("next");
  const [reanalyzing, setReanalyzing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`/api/salesos/lead-full?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      setD(r.ok ? await r.json() : null);
    } catch {
      /* leave prior data in place */
    }
  }, [id]);

  useEffect(() => {
    setD(null);
    setTab("next");
    setLoading(true);
    let cancelled = false;
    fetch(`/api/salesos/lead-full?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setD(j); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const reanalyze = useCallback(async (): Promise<void> => {
    setReanalyzing(true);
    try {
      const r = await fetch("/api/salesos/reanalyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      if (r.ok) await load(); // pull the refreshed state (+ everything derived from it)
    } catch {
      /* best-effort — button just re-enables */
    } finally {
      setReanalyzing(false);
    }
  }, [id, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tel = d?.clientPhone?.replace(/[^\d+]/g, "") ?? "";
  const tabs: { key: Tab; label: string; icon: typeof Sparkles }[] = [
    { key: "next", label: "Next step", icon: Sparkles },
    { key: "outreach", label: "Outreach", icon: MessageSquare },
    { key: "details", label: "Details", icon: ListChecks },
    { key: "ask", label: "Ask", icon: Search },
  ];

  return (
    <aside className="flex h-full w-full flex-col border-l border-border bg-panel">
      {/* header */}
      <div className="flex items-start justify-between gap-2 border-b border-border p-4">
        <div className="min-w-0">
          <div className="truncate text-[18px] font-medium tracking-tight">{d?.eventName || (loading ? "Loading…" : "Lead")}</div>
          <div className="text-[13px] text-tertiary-text">{d?.clientName || ""}</div>
        </div>
        <button onClick={onClose} aria-label="Close" className="shrink-0 rounded p-1 text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"><X className="size-5" /></button>
      </div>

      {!d ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-meta">{loading ? "Loading…" : "Couldn’t load this lead."}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-4 p-4">
            {/* meta + contact */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-meta">
              <span>{d.eventWhen}</span>
              {d.value != null && <span className="text-attention">{money(d.value)} potential</span>}
              {d.statusLabel && <span>GS: {d.statusLabel}</span>}
              <span className="rounded border border-border px-1.5 py-0.5">{d.stageLabel}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {d.hasPhone && <a href={`tel:${tel}`} className="flex items-center gap-1.5 rounded border border-foreground/70 px-3 py-1.5 text-[12.5px] transition-colors hover:bg-[var(--row-hover)]"><Phone className="size-4" /> Call</a>}
              {d.hasPhone && <a href={`sms:${tel}`} className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)]"><MessageSquare className="size-4" /> Text</a>}
              {d.hasEmail && <a href={`mailto:${d.clientEmail}`} className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)]"><Mail className="size-4" /> Email</a>}
              <a href={d.gsUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)]"><ExternalLink className="size-4" /> Goodshuffle</a>
            </div>

            {/* conversation feed */}
            <ConversationFeed items={d.feed} party={d.clientName || d.eventName} />
          </div>

          {/* tabs */}
          <div className="sticky top-0 z-10 flex gap-1 border-y border-border bg-panel px-2">
            {tabs.map((t) => {
              const on = tab === t.key;
              const Icon = t.icon;
              return (
                <button key={t.key} onClick={() => setTab(t.key)} className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${on ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                  <Icon className="size-4" /> {t.label}
                </button>
              );
            })}
          </div>

          <div className="p-4">
            {tab === "next" && <NextStep d={d} onReanalyze={reanalyze} reanalyzing={reanalyzing} />}
            {tab === "outreach" && <OutreachPanel id={d.id} viewer={viewer} />}
            {tab === "details" && <Details d={d} />}
            {tab === "ask" && <LeadAsk id={d.id} />}
          </div>
        </div>
      )}
    </aside>
  );
}

function NextStep({ d, onReanalyze, reanalyzing }: { d: FullLead; onReanalyze: () => void; reanalyzing: boolean }): React.JSX.Element {
  return (
    <div className="space-y-4">
      {d.state && (
        <div className="border-b border-[var(--row-rule)] pb-3">
          <div className="mb-0.5 flex items-center justify-between text-[10.5px] uppercase tracking-[0.1em] text-meta">
            <span>Customer state</span>
            <span className="tabular-nums">{d.state.confidence}%</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-[15px] font-medium">{d.state.label}</div>
            <button
              onClick={onReanalyze}
              disabled={reanalyzing}
              title="Re-read the notes + messages and recompute this state"
              className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-60"
            >
              <RefreshCw className={`size-3 ${reanalyzing ? "animate-spin" : ""}`} /> {reanalyzing ? "Analyzing…" : "Re-analyze"}
            </button>
          </div>
          {d.state.reason && <p className="mt-0.5 text-[12.5px] text-meta">{d.state.reason}</p>}
          {d.state.evidence && <p className="mt-1 border-l-2 border-[var(--bar-2)] pl-2 text-[12.5px] italic text-secondary-text">“{d.state.evidence}”</p>}
        </div>
      )}
      {d.nba && (
        <div>
          <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-meta"><Sparkles className="size-3.5" /> Next best action</div>
          <div className="text-[16px] font-semibold text-critical">{d.nba.label}</div>
          <p className="mt-0.5 text-[13.5px]">{d.nba.objective}</p>
          {d.nba.doNot && <p className="mt-1 flex items-start gap-1.5 text-[12.5px] text-attention"><AlertTriangle className="mt-0.5 size-3 shrink-0" /> Do not: {d.nba.doNot}</p>}
        </div>
      )}
      {d.brief && (
        <div className="border-t border-[var(--row-rule)] pt-3">
          <div className="mb-2 text-[10.5px] uppercase tracking-[0.1em] text-meta">Call brief</div>
          <div className="space-y-2 text-[13.5px]">
            <div><div className="text-[10.5px] uppercase tracking-[0.1em] text-meta">Opening</div><p>{d.brief.opening}</p></div>
            <div><div className="text-[10.5px] uppercase tracking-[0.1em] text-meta">Ask this</div><p className="font-medium">&ldquo;{d.brief.primaryQuestion}&rdquo;</p></div>
          </div>
        </div>
      )}
      {d.brief?.textDraft && (
        <QuoTextSend id={d.id} phone={d.clientPhone} clientName={d.clientName} canText={d.hasPhone} initialText={d.brief.textDraft} />
      )}
      {d.brief?.email.body && (
        <div className="border-t border-[var(--row-rule)] pt-3">
          <div className="mb-1.5 flex items-center justify-between"><div className="text-[10.5px] uppercase tracking-[0.1em] text-meta">Email follow-up</div><CopyButton text={`Subject: ${d.brief.email.subject}\n\n${d.brief.email.body}`} label="Copy email" /></div>
          <div className="border border-border bg-[var(--row)] p-2.5 text-[13.5px]">
            <div className="mb-1 text-[12px]"><span className="text-meta">Subject:</span> {d.brief.email.subject}</div>
            <pre className="whitespace-pre-wrap font-sans leading-relaxed">{d.brief.email.body}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Details({ d }: { d: FullLead }): React.JSX.Element {
  return (
    <div className="space-y-5">
      {d.internalNotes && (
        <div>
          <div className="mb-1.5 text-[10.5px] uppercase tracking-[0.1em] text-meta">Prior contact (Goodshuffle)</div>
          {d.clientNotes && <p className="mb-2 border border-attention/30 bg-attention/[0.06] p-2 text-[12px] text-attention">{d.clientNotes}</p>}
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap border border-border bg-[var(--row)] p-2.5 text-[12px] text-meta">{d.internalNotes}</pre>
        </div>
      )}
      <div>
        <div className="mb-2 flex items-center justify-between"><div className="text-[10.5px] uppercase tracking-[0.1em] text-meta">Why it&apos;s ranked here</div><div className="text-[13px] font-medium tabular-nums">score {d.priority.score}</div></div>
        <ul className="space-y-1.5">
          {d.priority.factors.map((f, i) => (
            <li key={i} className="flex items-center justify-between text-[13px]"><span className="text-meta">{f.label}</span><span className="tabular-nums">+{f.points}</span></li>
          ))}
        </ul>
      </div>
      <div>
        <div className="mb-2 text-[10.5px] uppercase tracking-[0.1em] text-meta">What we know</div>
        <dl className="space-y-1.5 text-[13px]">
          <Fact label="Quote created" value={d.facts.quoteCreated} />
          <Fact label="Quote sent" value={d.facts.quoteSent} />
          <Fact label="Event date" value={d.facts.eventDate} />
          {d.facts.deposit && <Fact label="Deposit" value={d.facts.deposit} />}
        </dl>
      </div>
      {d.activity.length > 0 && (
        <div>
          <div className="mb-2 text-[10.5px] uppercase tracking-[0.1em] text-meta">Activity</div>
          <ul className="space-y-1.5">
            {d.activity.map((a, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 text-[12px]">
                <span><span className="text-foreground">{a.actor}</span> <span className="text-meta">{a.actionLabel.toLowerCase()}{a.detail ? ` (${a.detail})` : ""}</span></span>
                <span className="shrink-0 tabular-nums text-meta">{new Date(a.ts).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <dt className="w-28 shrink-0 text-meta">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
