"use client";

// Pipeline Status (client) — the executive summary of every open quote in one dense, sortable,
// filterable grid, above a deterministic rollup. The filters/sorts are built to surface NEGLECT: quotes
// no rep has touched in > N days, quotes the client opened with no follow-up, and quotes where the
// customer is waiting on our reply. Row click opens the full verbatim activity timeline in the shared
// drawer. Money is redacted for Members. All figures are computed server-side; this view only presents.

import { useMemo, useState } from "react";
import { ArrowUp, ArrowDown, Download } from "lucide-react";
import type { ExecSummary, PipelineStatusRow } from "@/lib/salesos/execSummary";
import type { TimelineEntry } from "@/lib/salesos/timeline";
import { FigureStrip, tableCls, theadCls, tierBar, tierValueText, type Figure, type Tier } from "@/components/console-primitives";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { PipelineTimelinePanel } from "@/components/PipelineTimelinePanel";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const CHANNEL_LABEL: Record<TimelineEntry["channel"], string> = { sms: "Text", call: "Call", email: "Email", quote: "Quote", note: "Note", system: "Activity" };

function ago(iso: string | null): string {
  if (!iso) return "no record";
  const t = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return "no record";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function shortDate(ymd: string | null): string {
  if (!ymd) return "—";
  const d = new Date(ymd.length > 10 ? ymd : `${ymd}T00:00:00`);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const tsOf = (iso: string | null): number => {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};
const eventTone = (d: number | null): string => (d == null ? "text-meta" : d <= 7 ? "text-critical" : d <= 21 ? "text-attention" : "text-tertiary-text");

type FilterKey = "all" | "untouched7" | "untouched14" | "opened" | "awaiting" | "never";
type SortKey = "client" | "stage" | "amountDue" | "value" | "quoteSent" | "opened" | "activity" | "outbound" | "event";

export function PipelineStatusView({
  summary,
  rows,
  showMoney,
}: {
  summary: ExecSummary;
  rows: PipelineStatusRow[];
  showMoney: boolean;
}): React.JSX.Element {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sortKey, setSortKey] = useState<SortKey>("outbound");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<string | null>(null);

  const filters: { key: FilterKey; label: string; n: number; tone?: string }[] = [
    { key: "all", label: "All open", n: summary.openCount },
    { key: "untouched7", label: "No rep touch > 7d", n: summary.untouched7, tone: "text-critical" },
    { key: "untouched14", label: "No rep touch > 14d", n: summary.untouched14, tone: "text-critical" },
    { key: "opened", label: "Opened, no follow-up", n: summary.openedNoFollowup, tone: "text-amber-200" },
    { key: "awaiting", label: "Awaiting our reply", n: summary.awaitingReply, tone: "text-sky-300" },
    { key: "never", label: "Never contacted", n: summary.neverTouched, tone: "text-critical" },
  ];

  const matches = (r: PipelineStatusRow, f: FilterKey): boolean => {
    switch (f) {
      case "untouched7": return r.neglected7;
      case "untouched14": return r.neglected14;
      case "opened": return r.openedNoFollowup;
      case "awaiting": return r.awaitingReply;
      case "never": return r.daysSinceOutbound == null;
      default: return true;
    }
  };

  const sorted = useMemo(() => {
    const filtered = rows.filter((r) => matches(r, filter));
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (r: PipelineStatusRow): number | string => {
      switch (sortKey) {
        case "client": return (r.clientName || r.eventName || "").toLowerCase();
        case "stage": return r.boardStatusLabel.toLowerCase();
        case "amountDue": return r.amountDue ?? -1;
        case "value": return r.value ?? -1;
        case "quoteSent": return tsOf(r.quoteSentAt ?? r.quoteSentDate);
        case "opened": return tsOf(r.quoteOpenedAt);
        case "activity": return tsOf(r.lastActivity?.at ?? null);
        // "never contacted" is the most neglected → sort as +Infinity so desc puts it on top.
        case "outbound": return r.daysSinceOutbound == null ? Number.POSITIVE_INFINITY : r.daysSinceOutbound;
        case "event": return r.daysToEvent == null ? Number.POSITIVE_INFINITY : r.daysToEvent;
      }
    };
    return [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, filter, sortKey, sortDir]);

  const sort = (k: SortKey): void => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "client" || k === "stage" || k === "event" ? "asc" : "desc"); }
  };

  const figures: Figure[] = [
    { label: "Open quotes", value: summary.openCount },
    ...(showMoney
      ? ([{ label: "Pipeline", value: money(summary.totalPotential), sep: true }, { label: "Amount due", value: money(summary.totalAmountDue) }] as Figure[])
      : []),
    { label: "No touch 7d+", value: summary.untouched7, tone: summary.untouched7 ? "critical" : "default", sep: true },
    { label: "No touch 14d+", value: summary.untouched14, tone: summary.untouched14 ? "critical" : "default" },
    { label: "Opened, no f/u", value: summary.openedNoFollowup, tone: summary.openedNoFollowup ? "attention" : "default" },
    { label: "Awaiting reply", value: summary.awaitingReply, tone: summary.awaitingReply ? "attention" : "default" },
  ];

  const selectedRow = selected ? rows.find((r) => r.id === selected) ?? null : null;

  const th = (k: SortKey, label: string, right?: boolean): React.JSX.Element => (
    <th key={k} className={`px-2.5 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-meta ${right ? "text-right" : "text-left"}`}>
      <button onClick={() => sort(k)} className={`inline-flex items-center gap-1 hover:text-foreground ${sortKey === k ? "text-foreground" : ""} ${right ? "flex-row-reverse" : ""}`}>
        {label}
        {sortKey === k && (sortDir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );

  const colSpan = showMoney ? 8 : 6;

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      {/* Header + rollup */}
      <div className="flex flex-wrap items-end justify-between gap-4 px-6 pt-4 pb-3">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Pipeline Status</h1>
          <p className="mt-0.5 text-[12.5px] text-meta">
            Executive summary of every open quote · computed {new Date(summary.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            {summary.oldestNeglected ? ` · most neglected: ${summary.oldestNeglected.clientName || summary.oldestNeglected.eventName || summary.oldestNeglected.id}${summary.oldestNeglected.daysSinceOutbound != null ? ` (${summary.oldestNeglected.daysSinceOutbound}d)` : " (never contacted)"}` : ""}
          </p>
        </div>
        <FigureStrip figures={figures} />
      </div>

      {/* Filters + export */}
      <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
        {filters.map((f) => {
          const on = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(on ? "all" : f.key)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${on ? "border-white/40 bg-white/10 text-foreground" : "border-white/15 text-muted-foreground hover:text-foreground"}`}
            >
              <span className={on ? "" : f.tone ?? ""}>{f.label}</span>
              <span className="tabular-nums">{f.n}</span>
            </button>
          );
        })}
        {showMoney && (
          <div className="ml-auto flex items-center gap-2">
            <a href="/api/salesos/pipeline-status/export?format=csv" className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
              <Download className="size-3.5" /> CSV
            </a>
            <a href="/api/salesos/pipeline-status/export?format=json" className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
              <Download className="size-3.5" /> JSON
            </a>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="min-w-0 flex-1 overflow-auto border-t border-border">
        <table className={`${tableCls} min-w-[900px]`}>
          <thead className={theadCls}>
            <tr>
              {th("client", "Client / project")}
              {th("stage", "Stage")}
              {showMoney && th("amountDue", "Amount due", true)}
              {showMoney && th("value", "Value", true)}
              {th("quoteSent", "Quote sent → opened")}
              {th("activity", "Last activity")}
              {th("outbound", "Last rep outreach")}
              {th("event", "Event")}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={colSpan} className="px-6 py-16 text-center text-[13.5px] text-muted-foreground">No open quotes{filter !== "all" ? " in this filter" : ""}.</td></tr>
            ) : (
              sorted.map((r) => {
                const tier: Tier = r.daysSinceOutbound == null || r.neglected7 ? "now" : r.awaitingReply || r.openedNoFollowup ? "today" : "passive";
                const on = selected === r.id;
                return (
                  <tr
                    key={r.id}
                    onClick={() => setSelected(r.id)}
                    aria-current={on ? "true" : undefined}
                    className={`cursor-pointer border-t border-[var(--row-rule)] transition-colors ${on ? "bg-lifted" : "hover:bg-[var(--row-hover)]"}`}
                  >
                    <td className={`px-2.5 py-2.5 ${tierBar(tier)}`}>
                      <div className={`truncate text-[14px] font-medium ${tierValueText(tier)}`} title={r.eventName || r.clientName}>{r.eventName || `Project ${r.id}`}</div>
                      <div className="truncate text-[12px] text-meta">{r.clientName || "no client on record"}</div>
                    </td>
                    <td className="px-2.5 py-2.5">
                      <div className="text-[13px] text-tertiary-text">{r.boardStatusLabel}</div>
                      <div className="text-[12px] text-meta">{r.stateLabel}</div>
                    </td>
                    {showMoney && <td className={`px-2.5 py-2.5 text-right text-[13.5px] tabular-nums ${r.amountDue ? "text-amber-200" : "text-meta"}`}>{money(r.amountDue)}</td>}
                    {showMoney && <td className="px-2.5 py-2.5 text-right text-[13.5px] tabular-nums text-tertiary-text">{money(r.value)}</td>}
                    <td className="px-2.5 py-2.5">
                      <div className="text-[13px] tabular-nums text-tertiary-text">{shortDate(r.quoteSentAt ?? r.quoteSentDate)}</div>
                      <div className={`text-[12px] tabular-nums ${r.quoteOpenedAt ? "text-sky-300" : "text-meta"}`}>{r.quoteOpenedAt ? `opened ${shortDate(r.quoteOpenedAt)}` : "not opened"}</div>
                    </td>
                    <td className="px-2.5 py-2.5">
                      {r.lastActivity ? (
                        <>
                          <div className={`text-[13px] ${r.awaitingReply ? "text-sky-300" : "text-tertiary-text"}`}>{ago(r.lastActivity.at)}</div>
                          <div className="text-[12px] text-meta">{CHANNEL_LABEL[r.lastActivity.channel]}{r.lastActivity.direction === "in" ? " · from client" : r.lastActivity.direction === "out" ? " · to client" : ""}</div>
                        </>
                      ) : (
                        <span className="text-[13px] text-meta">no record</span>
                      )}
                    </td>
                    <td className="px-2.5 py-2.5">
                      {r.lastOutbound ? (
                        <>
                          <div className={`text-[13px] tabular-nums ${r.neglected7 ? "text-critical" : "text-tertiary-text"}`}>{ago(r.lastOutbound.at)}</div>
                          <div className="text-[12px] text-meta">{CHANNEL_LABEL[r.lastOutbound.channel]}{r.daysSinceOutbound != null ? ` · ${r.daysSinceOutbound}d` : ""}</div>
                        </>
                      ) : (
                        <span className="text-[13px] text-critical">never contacted</span>
                      )}
                    </td>
                    <td className="px-2.5 py-2.5">
                      <div className={`text-[13px] tabular-nums ${eventTone(r.daysToEvent)}`}>{r.daysToEvent == null ? "no date" : r.daysToEvent < 0 ? `${Math.abs(r.daysToEvent)}d ago` : r.daysToEvent === 0 ? "today" : `in ${r.daysToEvent}d`}</div>
                      <div className="text-[12px] text-meta">{shortDate(r.eventDate)}</div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {selectedRow && (
        <SidePanelOverlay onClose={() => setSelected(null)}>
          <PipelineTimelinePanel row={selectedRow} showMoney={showMoney} onClose={() => setSelected(null)} />
        </SidePanelOverlay>
      )}
    </main>
  );
}
