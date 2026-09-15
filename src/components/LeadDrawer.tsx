"use client";

// Board side-drawer (Jira-style): a right-hand panel that previews a lead without leaving the board.
// Fetches a compact snapshot on open; contact actions, state, next-best-action, recent messages, and
// an "Open full lead" link. Closes on backdrop / ✕ / Esc. The board stays mounted behind it, so a rep
// can click tile → tile → tile quickly. Read-only — outreach + edits happen on the full lead page.

import { useEffect, useState } from "react";
import Link from "next/link";
import { X, Phone, MessageSquare, Mail, Sparkles, AlertTriangle, ExternalLink } from "lucide-react";

interface QuickView {
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
  state: { label: string; reason: string | null; evidence: string | null; confidence: number } | null;
  nba: { label: string; objective: string; doNot: string | null } | null;
  conversation: { id: string; direction: string | null; channel: string | null; body: string; actor: string | null; at: string | null }[];
}

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const fmtWhen = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export function LeadDrawer({ id, onClose }: { id: string | null; onClose: () => void }): React.JSX.Element | null {
  const [data, setData] = useState<QuickView | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    setData(null);
    setLoading(true);
    let cancelled = false;
    fetch(`/api/salesos/lead-quickview?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setData(j); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, onClose]);

  if (!id) return null;
  const tel = data?.clientPhone?.replace(/[^\d+]/g, "") ?? "";

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-panel shadow-2xl">
        <div className="flex items-start justify-between gap-2 border-b border-border p-4">
          <div className="min-w-0">
            <div className="truncate text-[18px] font-medium tracking-tight">{data?.eventName || (loading ? "Loading…" : "Lead")}</div>
            <div className="text-[13px] text-tertiary-text">{data?.clientName || ""}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 rounded p-1 text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"><X className="size-5" /></button>
        </div>

        {!data ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-meta">{loading ? "Loading…" : "Couldn’t load this lead."}</div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-meta">
              <span>{data.eventWhen}</span>
              {data.value != null && <span className="text-attention">{money(data.value)} potential</span>}
              {data.statusLabel && <span>GS: {data.statusLabel}</span>}
            </div>

            <div className="flex flex-wrap gap-2">
              {data.hasPhone && <a href={`tel:${tel}`} className="flex items-center gap-1.5 rounded border border-foreground/70 px-3 py-1.5 text-[12.5px] transition-colors hover:bg-[var(--row-hover)]"><Phone className="size-4" /> Call</a>}
              {data.hasPhone && <a href={`sms:${tel}`} className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)]"><MessageSquare className="size-4" /> Text</a>}
              {data.hasEmail && <a href={`mailto:${data.clientEmail}`} className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)]"><Mail className="size-4" /> Email</a>}
            </div>

            {(data.state || data.nba) && (
              <section className="border border-border p-3">
                {data.state && (
                  <div className="mb-2 border-b border-[var(--row-rule)] pb-2">
                    <div className="mb-0.5 flex items-center justify-between text-[10.5px] uppercase tracking-[0.1em] text-meta"><span>Customer state</span><span className="tabular-nums">{data.state.confidence}%</span></div>
                    <div className="text-[14px] font-medium">{data.state.label}</div>
                    {data.state.reason && <p className="mt-0.5 text-[12px] text-meta">{data.state.reason}</p>}
                    {data.state.evidence && <p className="mt-1 border-l-2 border-[var(--bar-2)] pl-2 text-[12px] italic text-secondary-text">“{data.state.evidence}”</p>}
                  </div>
                )}
                {data.nba && (
                  <div>
                    <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-meta"><Sparkles className="size-3.5" /> Next best action</div>
                    <div className="text-[14px] font-medium">{data.nba.label}</div>
                    <p className="mt-0.5 text-[13px]">{data.nba.objective}</p>
                    {data.nba.doNot && <p className="mt-1 flex items-start gap-1.5 text-[12px] text-attention"><AlertTriangle className="mt-0.5 size-3 shrink-0" /> Do not: {data.nba.doNot}</p>}
                  </div>
                )}
              </section>
            )}

            {data.conversation.length > 0 && (
              <section>
                <div className="mb-2 text-[10.5px] uppercase tracking-[0.1em] text-meta">Recent messages</div>
                <ul className="space-y-2">
                  {data.conversation.map((cm) => {
                    const inbound = cm.direction === "inbound";
                    return (
                      <li key={cm.id} className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
                        <div className={`max-w-[85%] border p-2 text-[13px] ${cm.channel === "call" ? "border-[var(--bar)] bg-[var(--row-hover)]" : inbound ? "border-border bg-[var(--row-hover)]" : "border-[var(--bar-2)] bg-[#22303f]/40"}`}>
                          <div className="mb-0.5 text-[10px] uppercase tracking-[0.06em] text-meta">{cm.channel === "call" ? "Call" : inbound ? "Customer" : cm.actor || "Zoe"} · {fmtWhen(cm.at)}</div>
                          <div className="whitespace-pre-wrap">{cm.body}</div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        )}

        {data && (
          <div className="border-t border-border p-3">
            <Link href={`/salesos/${data.id}`} className="flex items-center justify-center gap-1.5 rounded border border-border py-2 text-[13px] font-medium transition-colors hover:bg-[var(--row-hover)]">
              Open full lead <ExternalLink className="size-4" />
            </Link>
          </div>
        )}
      </aside>
    </div>
  );
}
