"use client";

// Board quick view (Jira-style): a right-hand slide-over that peeks a lead's detail without leaving the
// Kanban. Fetches a compact snapshot on open; contact actions + "Open full" link. Closes on backdrop /
// Esc. Read-only — outreach + edits happen on the full lead page.

import { useEffect, useState } from "react";
import Link from "next/link";
import { X, Phone, MessageSquare, Mail, Sparkles, ArrowRight, AlertTriangle, ExternalLink } from "lucide-react";

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
  amountPaid: number | null;
  amountDue: number | null;
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

export function LeadQuickView({ id, onClose }: { id: string | null; onClose: () => void }): React.JSX.Element | null {
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
      <aside className="surface relative flex h-full w-full max-w-md flex-col border-l border-white/10 shadow-2xl">
        <div className="flex items-start justify-between gap-2 border-b border-white/10 p-4">
          <div className="min-w-0">
            <div className="truncate text-lg font-bold tracking-tight">{data?.eventName || (loading ? "Loading…" : "Lead")}</div>
            <div className="text-sm text-muted-foreground">{data?.clientName || ""}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-white/10 hover:text-foreground"><X className="size-5" /></button>
        </div>

        {!data ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{loading ? "Loading…" : "Couldn’t load this lead."}</div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {/* Meta */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{data.eventDate ? `${data.eventWhen}` : data.eventWhen}</span>
              {data.value != null && <span className="text-amber-200">{money(data.value)} potential</span>}
              {data.statusLabel && <span>GS: {data.statusLabel}</span>}
              <span className="rounded border border-white/15 px-1.5 py-0.5">{data.stageLabel}</span>
            </div>

            {/* Contact actions */}
            <div className="flex flex-wrap gap-2">
              {data.hasPhone && <a href={`tel:${tel}`} className="btn-hero flex items-center gap-1.5 px-3 py-1.5 text-sm"><Phone className="size-4" /> Call</a>}
              {data.hasPhone && <a href={`sms:${tel}`} className="flex items-center gap-1.5 border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5"><MessageSquare className="size-4" /> Text</a>}
              {data.hasEmail && <a href={`mailto:${data.clientEmail}`} className="flex items-center gap-1.5 border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5"><Mail className="size-4" /> Email</a>}
            </div>

            {/* State + next best action */}
            {(data.state || data.nba) && (
              <section className="surface border border-white/10 p-3">
                {data.state && (
                  <div className="mb-2 border-b border-white/5 pb-2">
                    <div className="mb-0.5 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground"><span>Customer state</span><span className="tabular-nums">{data.state.confidence}%</span></div>
                    <div className="text-sm font-semibold">{data.state.label}</div>
                    {data.state.reason && <p className="mt-0.5 text-xs text-muted-foreground">{data.state.reason}</p>}
                    {data.state.evidence && <p className="mt-1 border-l-2 border-sky-500/40 pl-2 text-xs italic text-sky-200/90">“{data.state.evidence}”</p>}
                  </div>
                )}
                {data.nba && (
                  <div>
                    <div className="mb-0.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><Sparkles className="size-3.5" /> Next best action</div>
                    <div className="text-sm font-semibold">{data.nba.label}</div>
                    <p className="mt-0.5 text-sm">{data.nba.objective}</p>
                    {data.nba.doNot && <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-200"><AlertTriangle className="mt-0.5 size-3 shrink-0" /> Do not: {data.nba.doNot}</p>}
                  </div>
                )}
              </section>
            )}

            {/* Recent conversation */}
            {data.conversation.length > 0 && (
              <section>
                <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Recent messages</div>
                <ul className="space-y-2">
                  {data.conversation.map((c) => {
                    const inbound = c.direction === "inbound";
                    return (
                      <li key={c.id} className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
                        <div className={`max-w-[85%] rounded-lg border p-2 text-sm ${c.channel === "call" ? "border-violet-500/30 bg-violet-500/[0.07]" : inbound ? "border-white/10 bg-white/[0.05]" : "border-sky-500/30 bg-sky-500/[0.1]"}`}>
                          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{c.channel === "call" ? "Call" : inbound ? "Customer" : c.actor || "Zoe"} · {fmtWhen(c.at)}</div>
                          <div className="whitespace-pre-wrap">{c.body}</div>
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
          <div className="border-t border-white/10 p-3">
            <Link href={`/salesos/${data.id}`} className="flex items-center justify-center gap-1.5 rounded-lg border border-white/15 py-2 text-sm font-medium hover:bg-white/5">
              Open full lead <ExternalLink className="size-4" />
            </Link>
          </div>
        )}
      </aside>
    </div>
  );
}
