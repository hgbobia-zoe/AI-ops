"use client";

// Master-detail shell for Sales OS. Left: the ranked action worklist (scorecard + filter tabs + lead
// rows), a persistent sidebar on desktop and a drawer on mobile. Right: the selected lead's board
// (children). Selection is URL-driven (Link → /salesos/[id]) so the board is server-rendered, but the
// worklist persists and highlights the active lead without a full navigation. The analytical sub-views
// (Bid / Lost / Trends) render full-bleed — the shell steps out of the way for those.

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, PanelLeftOpen, X, CalendarRange, Scale, TrendingDown, MessageCircle, Zap } from "lucide-react";
import type { QueueItem } from "@/lib/salesos/commandCenter";
import { NBA_LABEL, type NbaAction } from "@/lib/salesos/nba";
import type { CustomerState } from "@/lib/salesos/state";

type Filter = "all" | "attention" | "replied";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attention", label: "Attention" },
  { key: "replied", label: "Replied" },
];

const ACTION_STYLE: Record<NbaAction, string> = {
  CALL_NOW: "border-rose-500/50 bg-rose-500/15 text-rose-100",
  HANDLE_OBJECTION: "border-amber-500/50 bg-amber-500/15 text-amber-100",
  CLOSE: "border-emerald-500/50 bg-emerald-500/15 text-emerald-100",
  ESCALATE: "border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-100",
  VERIFY_AVAILABILITY: "border-sky-500/40 bg-sky-500/10 text-sky-100",
  CONFIRM_LOGISTICS: "border-sky-500/40 bg-sky-500/10 text-sky-100",
  ASK_DISCOVERY: "border-sky-500/40 bg-sky-500/10 text-sky-100",
  REVIEW_QUOTE: "border-white/20 bg-white/5 text-foreground",
  SEND_SMS: "border-sky-500/40 bg-sky-500/10 text-sky-100",
  FOLLOW_UP: "border-white/15 bg-white/5 text-muted-foreground",
  WAIT: "border-white/10 bg-white/5 text-muted-foreground",
  NO_ACTION: "border-white/10 bg-white/5 text-muted-foreground",
};

const STATE_TONE: Partial<Record<CustomerState, string>> = {
  PRICE_OBJECTION: "text-amber-300",
  COMPETITOR_COMPARISON: "text-amber-300",
  READY_TO_BOOK: "text-emerald-300",
  EVALUATING: "text-sky-300",
  DORMANT: "text-muted-foreground",
};

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const needsAttention = (a: NbaAction): boolean => a !== "WAIT" && a !== "NO_ACTION";

function repliedLabel(mins: number | null): string | null {
  if (mins == null) return null;
  if (mins < 60) return `replied ${mins}m ago`;
  if (mins < 1440) return `replied ${Math.round(mins / 60)}h ago`;
  return null;
}

export function SalesShell({
  queue,
  showMoney,
  needAttention,
  justReplied,
  totalPotential,
  children,
}: {
  queue: QueueItem[];
  showMoney: boolean;
  needAttention: number;
  justReplied: number;
  totalPotential: number | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  // The analytical sub-views own the whole pane — no worklist rail.
  const seg = pathname.split("/")[2] ?? "";
  if (seg === "bid" || seg === "lost" || seg === "trends") return <>{children}</>;

  const activeId = pathname.match(/^\/salesos\/([^/]+)/)?.[1] ?? queue[0]?.id ?? null;
  const activeItem = queue.find((q) => q.id === activeId) ?? null;

  useEffect(() => setDrawer(false), [pathname]);

  const counts: Record<Filter, number> = {
    all: queue.length,
    attention: queue.filter((q) => needsAttention(q.nba.action)).length,
    replied: queue.filter((q) => q.repliedMinutesAgo != null && q.repliedMinutesAgo <= 1440).length,
  };

  const shown = queue.filter((q) => {
    if (filter === "attention") return needsAttention(q.nba.action);
    if (filter === "replied") return q.repliedMinutesAgo != null && q.repliedMinutesAgo <= 1440;
    return true;
  });

  const listBody = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 md:pt-5">
        <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <Sparkles className="size-5" /> Sales OS
        </h1>
        <button onClick={() => setDrawer(false)} className="text-muted-foreground lg:hidden" aria-label="Close">
          <X className="size-5" />
        </button>
      </div>

      {/* Scorecard — the operator's at-a-glance state */}
      <div className="grid grid-cols-3 gap-1.5 px-3 pt-3">
        <Stat icon={Zap} label="Attention" value={needAttention} tone="text-foreground" />
        <Stat icon={MessageCircle} label="Replied" value={justReplied} tone="text-sky-200" />
        <Stat label={showMoney ? "Pipeline" : "Open"} value={showMoney ? money(totalPotential) : queue.length} tone="text-amber-200" />
      </div>

      {/* Global sub-views */}
      <div className="flex flex-wrap gap-1.5 px-3 pt-2 text-xs">
        <Link href="/salesos/trends" className="flex items-center gap-1 border border-white/10 px-2 py-1 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground">
          <CalendarRange className="size-3.5" /> Trends
        </Link>
        {showMoney && (
          <Link href="/salesos/bid" className="flex items-center gap-1 border border-white/10 px-2 py-1 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground">
            <Scale className="size-3.5" /> Bid review
          </Link>
        )}
        <Link href="/salesos/lost" className="flex items-center gap-1 border border-white/10 px-2 py-1 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground">
          <TrendingDown className="size-3.5" /> Lost quotes
        </Link>
      </div>

      {/* Filter tabs — one line, no wrap */}
      <div className="flex gap-1 px-3 pt-3">
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {shown.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">{queue.length === 0 ? "No open leads — the pipeline is clear." : "No leads match this filter."}</p>
        ) : (
          <ol className="space-y-1">
            {shown.map((it) => {
              const on = it.id === activeId;
              const replied = repliedLabel(it.repliedMinutesAgo);
              const dte = it.daysToEvent;
              const when = dte == null ? "no date" : dte < 0 ? `${Math.abs(dte)}d ago` : dte === 0 ? "today" : dte === 1 ? "tomorrow" : `in ${dte}d`;
              return (
                <li key={it.id}>
                  <Link
                    href={`/salesos/${it.id}`}
                    onClick={() => setDrawer(false)}
                    aria-current={on ? "page" : undefined}
                    className={`block rounded-lg border px-2.5 py-2 transition-colors ${on ? "border-white/15 bg-white/[0.08]" : "border-transparent hover:bg-white/[0.04]"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{it.eventName || it.clientName || `Project ${it.id}`}</span>
                      {replied && <span className="ml-auto shrink-0 rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 py-px text-[9px] text-sky-200">{replied}</span>}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] font-semibold ${ACTION_STYLE[it.nba.action]}`}>{NBA_LABEL[it.nba.action]}</span>
                      <span className={`shrink-0 text-[10px] font-medium ${STATE_TONE[it.state.state] ?? "text-muted-foreground"}`}>{it.stateLabel}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className={dte != null && dte >= 0 && dte <= 14 ? "text-rose-200" : ""}>{when}</span>
                      {showMoney && it.value != null && <span className="ml-auto tabular-nums text-amber-200">{money(it.value)}</span>}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col lg:flex-row lg:items-start">
      {/* Sidebar (large screens) */}
      <aside className="hidden lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-[340px] lg:shrink-0 lg:flex-col lg:border-r lg:border-white/10">
        {listBody}
      </aside>

      {/* Drawer (small/medium screens) */}
      {drawer && <div className="fixed inset-0 z-40 bg-background lg:hidden">{listBody}</div>}

      {/* Detail pane */}
      <section className="min-w-0 flex-1">
        <div className="flex items-center gap-2 border-b border-white/10 p-3 lg:hidden">
          <button onClick={() => setDrawer(true)} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-sm text-muted-foreground">
            <PanelLeftOpen className="size-4" /> Leads
          </button>
          <span className="truncate text-sm font-medium">{activeItem?.eventName || activeItem?.clientName || "Sales OS"}</span>
        </div>
        {children}
      </section>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone }: { icon?: typeof Zap; label: string; value: string | number; tone: string }): React.JSX.Element {
  return (
    <div className="surface border border-white/5 p-2">
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-muted-foreground">{Icon && <Icon className="size-3" />} {label}</div>
      <div className={`mt-0.5 text-lg font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
