"use client";

// Master-detail shell for the Coaching blade. Left: the call list (filter tabs + day-grouped rows),
// a persistent sidebar on desktop and a drawer on mobile. Right: the selected call's board (children).
// Selection is URL-driven (Link → /coaching/[id]) so the board is server-rendered, but the list
// persists and highlights the active call without a full navigation.

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Headphones, PhoneIncoming, PhoneOutgoing, SmilePlus, Meh, Frown, PanelLeftOpen, X } from "lucide-react";
import type { CoachableCall } from "@/lib/db/repo";
import { BackfillDriver } from "./BackfillDriver";
import { NameEnricher } from "./NameEnricher";
import { HistoryImporter } from "./HistoryImporter";

type Filter = "all" | "positive" | "neutral" | "negative" | "pending";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "positive", label: "Positive" },
  { key: "neutral", label: "Neutral" },
  { key: "negative", label: "Negative" },
];

const SENTIMENT_CHIP: Record<string, string> = {
  positive: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  negative: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  neutral: "border-white/10 bg-white/5 text-muted-foreground",
};

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "—";
  const t = Math.round(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
}
function dayLabel(iso: string | null): string {
  if (!iso) return "Earlier";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Earlier";
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, y)) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function initials(name: string): string {
  const parts = name.replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
}
function SentIcon({ s }: { s: string }): React.JSX.Element {
  if (s === "positive") return <SmilePlus className="size-3" />;
  if (s === "negative") return <Frown className="size-3" />;
  return <Meh className="size-3" />;
}

export function CoachingShell({ calls, unanalyzed, children }: { calls: CoachableCall[]; unanalyzed: number; children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const activeId = pathname.match(/^\/coaching\/([^/]+)/)?.[1] ?? calls[0]?.id ?? null;
  const activeCall = calls.find((c) => c.id === activeId) ?? null;

  // Close the mobile drawer whenever the route changes (a call was picked).
  useEffect(() => setDrawer(false), [pathname]);

  const counts: Record<Filter, number> = {
    all: calls.length,
    positive: calls.filter((c) => c.sentiment === "positive").length,
    neutral: calls.filter((c) => c.sentiment === "neutral" || !c.sentiment).length,
    negative: calls.filter((c) => c.sentiment === "negative").length,
    pending: calls.filter((c) => !c.analyzed).length,
  };

  const shown = calls.filter((c) => {
    if (filter === "all") return true;
    if (filter === "pending") return !c.analyzed;
    if (filter === "neutral") return c.sentiment === "neutral" || !c.sentiment;
    return c.sentiment === filter;
  });

  // One row per contact (Quo-style): combine a caller's calls into a single conversation, represented
  // by their most recent call. `shown` is newest-first, so the first seen per contact is the rep.
  const last10 = (p: string | null): string | null => {
    const d = (p ?? "").replace(/\D/g, "");
    return d.length >= 10 ? d.slice(-10) : null;
  };
  const convByKey = new Map<string, { rep: CoachableCall; count: number; ids: string[] }>();
  for (const c of shown) {
    const key = last10(c.customerPhone) || c.caller.trim().toLowerCase() || c.id;
    const ex = convByKey.get(key);
    if (ex) {
      ex.count++;
      ex.ids.push(c.id);
    } else {
      convByKey.set(key, { rep: c, count: 1, ids: [c.id] });
    }
  }
  const conversations = [...convByKey.values()];

  const groups: { label: string; items: { rep: CoachableCall; count: number; ids: string[] }[] }[] = [];
  for (const cv of conversations) {
    const label = dayLabel(cv.rep.occurredAt ?? cv.rep.ts);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(cv);
    else groups.push({ label, items: [cv] });
  }

  const listBody = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 md:pt-5">
        <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <Headphones className="size-5" /> Coaching
        </h1>
        <button onClick={() => setDrawer(false)} className="text-muted-foreground lg:hidden" aria-label="Close">
          <X className="size-5" />
        </button>
      </div>
      {/* Filter tabs — one line, no wrap, no scrollbar. Count rides inline after the label. */}
      <div className="flex gap-1 px-3 pt-2">
        {FILTERS.map((t) => {
          const on = filter === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              className={`flex min-w-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                on ? "bg-white/[0.1] text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="truncate">{t.label}</span>
              <span className="tabular-nums opacity-60">{counts[t.key]}</span>
            </button>
          );
        })}
      </div>

      {unanalyzed > 0 && (
        <div className="px-3 pt-2">
          <BackfillDriver initialRemaining={unanalyzed} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {shown.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">{calls.length === 0 ? "No calls with transcripts yet." : "No calls match this filter."}</p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-3">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</div>
              <ol className="space-y-1">
                {g.items.map((cv) => {
                  const c = cv.rep;
                  const on = cv.ids.includes(activeId ?? "");
                  const named = /[A-Za-z]/.test(c.caller);
                  return (
                    <li key={c.id}>
                      <Link
                        href={`/coaching/${c.id}`}
                        onClick={() => setDrawer(false)}
                        aria-current={on ? "page" : undefined}
                        className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors ${
                          on ? "border-white/15 bg-white/[0.08]" : "border-transparent hover:bg-white/[0.04]"
                        }`}
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[11px] font-semibold text-muted-foreground">
                          {named ? initials(c.caller) : c.direction === "outgoing" ? <PhoneOutgoing className="size-3.5" /> : <PhoneIncoming className="size-3.5" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{c.caller}</span>
                            {cv.count > 1 && <span className="shrink-0 rounded-full bg-white/[0.08] px-1.5 text-[10px] tabular-nums text-muted-foreground">{cv.count}</span>}
                          </div>
                          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <span>{fmtTime(c.occurredAt ?? c.ts)}</span>
                            <span>· {fmtDuration(c.durationSec)}</span>
                            {c.sentiment && (
                              <span className={`ml-auto inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[9px] font-medium capitalize ${SENTIMENT_CHIP[c.sentiment] ?? SENTIMENT_CHIP.neutral}`}>
                                <SentIcon s={c.sentiment} /> {c.sentiment}
                              </span>
                            )}
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Continuous background loops: resolve names for un-named numbers, and import past calls. */}
      <NameEnricher />
      <HistoryImporter />

      <div className="flex flex-col lg:flex-row lg:items-start">
      {/* Sidebar (large screens) */}
      <aside className="hidden lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-[340px] lg:shrink-0 lg:flex-col lg:border-r lg:border-white/10">
        {listBody}
      </aside>

      {/* Drawer (small/medium screens) */}
      {drawer && (
        <div className="fixed inset-0 z-40 bg-background lg:hidden">{listBody}</div>
      )}

      {/* Detail pane */}
      <section className="min-w-0 flex-1">
        {/* Top bar with the list toggle (small/medium screens) */}
        <div className="flex items-center gap-2 border-b border-white/10 p-3 lg:hidden">
          <button onClick={() => setDrawer(true)} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-sm text-muted-foreground">
            <PanelLeftOpen className="size-4" /> Calls
          </button>
          <span className="truncate text-sm font-medium">{activeCall?.caller ?? "Coaching"}</span>
        </div>
        {children}
      </section>
      </div>
    </>
  );
}
