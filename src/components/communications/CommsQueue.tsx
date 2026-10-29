"use client";

// The Communications queue — the operating desk. Real rows from real calls + SMS (the live Quo feed),
// enriched with the calculated reason, matched customer/event, identity confidence and open risk.
//
// The desk reads as one board: a header with scope + freshness + the primary work counts, a COMPACT
// primary toolbar (channel quick-filter + search) with a collapsible SECONDARY filter panel (handled-by
// / state / desk / time) and column controls, then a sticky-header table that prioritises time, contact
// identity, the associated customer/event, reason, channel and the actionable status. The caller and the
// matched customer are shown as DISTINCT facets (who called vs who we matched) and unknown/unmatched is
// always explicit. Narrow screens get an actionable card list instead of a wide table. RULES CALCULATE,
// AI INTERPRETS — nothing here fabricates a match, an outcome, or an AI-handled call.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Headset, RefreshCw, Loader2, PhoneIncoming, PhoneOutgoing, MessageSquare,
  ArrowUp, ArrowDown, SlidersHorizontal, Columns3, X, Search, AlertTriangle,
} from "lucide-react";
import { BladeMain } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status";
import { tableCls, theadCls, thCls, tdCls, rowCls, FigureStrip } from "@/components/console-primitives";
import type { QueueRow, CallCard } from "@/lib/comms/types";
import {
  filterRows, sortRows, activeFilterCount, anyFilterActive, ymd, EMPTY_FILTERS,
  channelDescriptor, handledText, statusText, statusTone, dispositionText,
  type QueueFilters, type SortKey, type SortDir,
} from "@/lib/comms/queueView";
import { CallDetailPanel } from "./CallDetailPanel";
import { fmtWhen, fmtDuration, reasonLabel, IDENTITY_LABEL, IDENTITY_TONE } from "./helpers";

// Which extra (non-priority) dimensions are shown as columns. All off by default — they stay reachable
// here and in the detail panel, so the default grid is uncluttered.
interface ExtraCols { handled: boolean; disposition: boolean; risk: boolean }
const EXTRA_OFF: ExtraCols = { handled: false, disposition: false, risk: false };

const COL_W = {
  time: 104, contact: 192, context: 184, reason: 130, channel: 120, status: 124,
  handled: 100, disposition: 132, risk: 72,
} as const;

export function CommsQueue({ showMoney }: { showMoney: boolean }): React.JSX.Element {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [filters, setFilters] = useState<QueueFilters>(EMPTY_FILTERS);
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showFilters, setShowFilters] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const [cols, setCols] = useState<ExtraCols>(EXTRA_OFF);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [card, setCard] = useState<CallCard | null>(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // today/yesterday computed once (never during render — keeps the component pure).
  const [{ today, yesterday }] = useState(() => {
    const t = new Date();
    const y = new Date();
    y.setDate(y.getDate() - 1);
    return { today: ymd(t), yesterday: ymd(y) };
  });

  useEffect(() => {
    let alive = true;
    fetch("/api/communications/queue")
      .then((r) => r.json())
      .then((j: { rows: QueueRow[]; generatedAt?: string }) => {
        if (!alive) return;
        setRows(j.rows ?? []);
        setGeneratedAt(j.generatedAt ?? new Date().toISOString());
      })
      .catch(() => { if (alive) setRows([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reloadKey]);

  const refresh = useCallback(() => { setLoading(true); setReloadKey((k) => k + 1); }, []);

  const openCard = useCallback((id: string) => {
    setSelectedId(id);
    setCard(null);
    setCardLoading(true);
    fetch(`/api/communications/call/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: CallCard | null) => setCard(j))
      .catch(() => setCard(null))
      .finally(() => setCardLoading(false));
  }, []);

  const changeReason = useCallback(
    (reason: string | null) => {
      if (!selectedId) return;
      setSaving(true);
      fetch(`/api/communications/call/${encodeURIComponent(selectedId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { card: CallCard } | null) => {
          if (j?.card) {
            setCard(j.card);
            setRows((prev) => prev?.map((row) => (row.id === selectedId ? j.card.row : row)) ?? prev);
          }
        })
        .finally(() => setSaving(false));
    },
    [selectedId],
  );

  const filtered = useMemo(
    () => sortRows(filterRows(rows ?? [], filters, q, today, yesterday), sortKey, sortDir),
    [rows, filters, q, sortKey, sortDir, today, yesterday],
  );

  const figures = useMemo(() => {
    const all = rows ?? [];
    return [
      { label: "In view", value: filtered.length },
      { label: "Escalated", value: all.filter((r) => r.disposition === "ESCALATED").length, tone: "critical" as const, sep: true },
      { label: "Unidentified", value: all.filter((r) => r.identityConfidence === "UNKNOWN").length, tone: "attention" as const },
      { label: "Today", value: all.filter((r) => (r.occurredAt ?? r.ts).slice(0, 10) === today).length, sep: true },
    ];
  }, [rows, filtered.length, today]);

  const toggleSort = (k: SortKey): void => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "caller" || k === "reason" ? "asc" : "desc"); }
  };
  const ariaSort = (k: SortKey): "ascending" | "descending" | "none" => (sortKey !== k ? "none" : sortDir === "asc" ? "ascending" : "descending");
  const sortIcon = (k: SortKey): React.ReactNode => (sortKey !== k ? null : sortDir === "asc" ? <ArrowUp className="inline size-3" aria-hidden /> : <ArrowDown className="inline size-3" aria-hidden />);

  const activeCount = activeFilterCount(filters);
  const minWidth = COL_W.time + COL_W.contact + COL_W.context + COL_W.reason + COL_W.channel + COL_W.status
    + (cols.handled ? COL_W.handled : 0) + (cols.disposition ? COL_W.disposition : 0) + (cols.risk ? COL_W.risk : 0);

  const scopeLine = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>Live calls &amp; SMS from Quo</span>
      <span aria-hidden>·</span>
      {generatedAt
        ? <Freshness iso={generatedAt} />
        : <span>Loading…</span>}
    </span>
  );

  return (
    <BladeMain>
      <PageHeader
        icon={<Headset className="size-5" />}
        title="Communications"
        subtitle={scopeLine}
        actions={
          <button
            onClick={refresh}
            className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-row-hover hover:text-foreground"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden /> Refresh
          </button>
        }
      />

      <div className="surface mb-4 overflow-x-auto border border-border p-3">
        <FigureStrip figures={figures} />
      </div>

      {/* Primary toolbar — channel quick filter + search + secondary-panel / column toggles */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel="Channel"
          value={filters.channel}
          onChange={(v) => setFilters((f) => ({ ...f, channel: v as QueueFilters["channel"] }))}
          options={[["", "All"], ["call", "Calls"], ["sms", "SMS"]]}
        />
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-meta" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search caller, phone, customer, event…"
            aria-label="Search the queue"
            className="w-60 rounded border border-border bg-row py-1.5 pl-8 pr-2.5 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/40"
          />
        </div>
        <ToolbarToggle active={showFilters || activeCount > 0} onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
          <SlidersHorizontal className="size-3.5" aria-hidden /> Filters
          {activeCount > 0 && <span className="ml-0.5 rounded-full bg-foreground/[0.12] px-1.5 text-[10.5px] tabular-nums">{activeCount}</span>}
        </ToolbarToggle>
        <ToolbarToggle active={showCols} onClick={() => setShowCols((s) => !s)} aria-expanded={showCols}>
          <Columns3 className="size-3.5" aria-hidden /> Columns
        </ToolbarToggle>
      </div>

      {/* Secondary filter panel */}
      {showFilters && (
        <div className="surface mb-3 grid grid-cols-1 gap-3 border border-border p-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterField label="Handled by" value={filters.handled} onChange={(v) => setFilters((f) => ({ ...f, handled: v as QueueFilters["handled"] }))} options={[["", "All"], ["HUMAN", "Human"], ["TRANSFERRED", "Transferred"], ["AI", "AI"]]} />
          <FilterField label="State" value={filters.disposition} onChange={(v) => setFilters((f) => ({ ...f, disposition: v as QueueFilters["disposition"] }))} options={[["", "Any"], ["UNRESOLVED", "Unresolved"], ["ESCALATED", "Escalated"]]} />
          <FilterField label="Desk" value={filters.desk} onChange={(v) => setFilters((f) => ({ ...f, desk: v as QueueFilters["desk"] }))} options={[["", "All"], ["SALES", "Sales"], ["OPERATIONS", "Operations"], ["BILLING", "Billing"]]} />
          <FilterField label="Time" value={filters.day} onChange={(v) => setFilters((f) => ({ ...f, day: v as QueueFilters["day"] }))} options={[["", "All time"], ["today", "Today"], ["yesterday", "Yesterday"]]} />
        </div>
      )}

      {/* Column controls */}
      {showCols && (
        <div className="surface mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 border border-border p-3">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-meta">Extra columns</span>
          <ColToggle label="Handled by" checked={cols.handled} onChange={(v) => setCols((c) => ({ ...c, handled: v }))} />
          <ColToggle label="Disposition" checked={cols.disposition} onChange={(v) => setCols((c) => ({ ...c, disposition: v }))} />
          <ColToggle label="Open risk" checked={cols.risk} onChange={(v) => setCols((c) => ({ ...c, risk: v }))} />
          <span className="text-[11px] text-meta">Always shown in a row&rsquo;s detail.</span>
        </div>
      )}

      {/* Active filters + clear-all */}
      {anyFilterActive(filters) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.08em] text-meta">Active</span>
          {filters.channel && <FilterChip label={filters.channel === "sms" ? "SMS" : "Calls"} onRemove={() => setFilters((f) => ({ ...f, channel: "" }))} />}
          {filters.handled && <FilterChip label={`Handled: ${handledText(filters.handled)}`} onRemove={() => setFilters((f) => ({ ...f, handled: "" }))} />}
          {filters.disposition && <FilterChip label={filters.disposition === "ESCALATED" ? "Escalated" : "Unresolved"} onRemove={() => setFilters((f) => ({ ...f, disposition: "" }))} />}
          {filters.desk && <FilterChip label={`Desk: ${filters.desk[0] + filters.desk.slice(1).toLowerCase()}`} onRemove={() => setFilters((f) => ({ ...f, desk: "" }))} />}
          {filters.day && <FilterChip label={filters.day === "today" ? "Today" : "Yesterday"} onRemove={() => setFilters((f) => ({ ...f, day: "" }))} />}
          <button onClick={() => setFilters(EMPTY_FILTERS)} className="text-[11.5px] text-meta underline-offset-2 hover:text-foreground hover:underline">
            Clear all
          </button>
        </div>
      )}

      {/* Body */}
      {loading || rows === null ? (
        <div className="flex items-center gap-2 py-10 text-[13px] text-meta"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading the queue…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Headset className="size-6" />}
          title={(rows ?? []).length === 0 ? "Nothing in the queue yet" : "No rows match these filters"}
          body={(rows ?? []).length === 0 ? "Calls and SMS appear here from Quo as they happen." : "Adjust or clear the filters to see more."}
          action={anyFilterActive(filters) ? <button onClick={() => setFilters(EMPTY_FILTERS)} className="rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text hover:bg-row-hover hover:text-foreground">Clear filters</button> : undefined}
        />
      ) : (
        <>
          {/* Desktop / tablet — the data grid */}
          <div className="hidden overflow-x-auto rounded border border-border md:block">
            <table className={tableCls} style={{ minWidth }}>
              <colgroup>
                <col style={{ width: COL_W.time }} />
                <col style={{ width: COL_W.contact }} />
                <col style={{ width: COL_W.context }} />
                <col style={{ width: COL_W.reason }} />
                <col style={{ width: COL_W.channel }} />
                <col style={{ width: COL_W.status }} />
                {cols.handled && <col style={{ width: COL_W.handled }} />}
                {cols.disposition && <col style={{ width: COL_W.disposition }} />}
                {cols.risk && <col style={{ width: COL_W.risk }} />}
              </colgroup>
              <thead className={theadCls}>
                <tr>
                  <SortTh label="Time" onClick={() => toggleSort("time")} aria-sort={ariaSort("time")}>{sortIcon("time")}</SortTh>
                  <SortTh label="Contact" onClick={() => toggleSort("caller")} aria-sort={ariaSort("caller")}>{sortIcon("caller")}</SortTh>
                  <th className={thCls} scope="col">Customer / event</th>
                  <SortTh label="Reason" onClick={() => toggleSort("reason")} aria-sort={ariaSort("reason")}>{sortIcon("reason")}</SortTh>
                  <th className={thCls} scope="col">Channel</th>
                  <th className={thCls} scope="col">Status</th>
                  {cols.handled && <th className={thCls} scope="col">Handled by</th>}
                  {cols.disposition && <th className={thCls} scope="col">Disposition</th>}
                  {cols.risk && <th className={`${thCls} cursor-pointer text-right`} scope="col" aria-sort={ariaSort("risk")}><button onClick={() => toggleSort("risk")} className="uppercase tracking-[0.08em]">Risk {sortIcon("risk")}</button></th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const ch = channelDescriptor(r);
                  const Dir = r.channel === "sms" ? MessageSquare : r.direction === "outgoing" ? PhoneOutgoing : PhoneIncoming;
                  return (
                    <tr key={r.id} onClick={() => openCard(r.id)} className={`${rowCls} cursor-pointer ${selectedId === r.id ? "bg-row-hover" : ""}`}>
                      <td className={`${tdCls} whitespace-nowrap text-[12px] text-meta`}>{fmtWhen(r.occurredAt ?? r.ts)}</td>
                      <td className={tdCls}><ContactCell r={r} /></td>
                      <td className={tdCls}><ContextCell r={r} /></td>
                      <td className={`${tdCls} truncate text-[12.5px] text-tertiary-text`}>{reasonLabel(r.reason)}</td>
                      <td className={tdCls}>
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-tertiary-text" title={ch.full}>
                          <Dir className="size-3.5 shrink-0 text-meta" aria-hidden />
                          <span>{ch.short}</span>
                        </span>
                      </td>
                      <td className={tdCls}><StatusBadge tone={statusTone(r.status)} size="sm">{statusText(r.status)}</StatusBadge></td>
                      {cols.handled && <td className={`${tdCls} text-[12px] ${r.handledBy === "HUMAN" ? "text-tertiary-text" : "text-meta"}`}>{handledText(r.handledBy)}</td>}
                      {cols.disposition && <td className={`${tdCls} text-[12px] ${r.disposition === "ESCALATED" ? "text-foreground" : "text-meta"}`}>{dispositionText(r.disposition)}</td>}
                      {cols.risk && <td className={`${tdCls} text-right tabular-nums ${r.riskCount > 0 ? "text-foreground" : "text-meta"}`}>{r.riskCount || "—"}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile — an actionable list that opens the detail */}
          <ul className="space-y-2 md:hidden">
            {filtered.map((r) => {
              const ch = channelDescriptor(r);
              const Dir = r.channel === "sms" ? MessageSquare : r.direction === "outgoing" ? PhoneOutgoing : PhoneIncoming;
              return (
                <li key={r.id}>
                  <button onClick={() => openCard(r.id)} className="surface w-full rounded border border-border p-3 text-left transition-colors hover:bg-row-hover">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-tertiary-text" title={ch.full}>
                        <Dir className="size-3.5 shrink-0 text-meta" aria-hidden /> {ch.short}
                      </span>
                      <span className="text-[11.5px] text-meta">{fmtWhen(r.occurredAt ?? r.ts)}</span>
                    </div>
                    <div className="mt-1.5"><ContactCell r={r} /></div>
                    <div className="mt-1.5"><ContextCell r={r} /></div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[12px] text-tertiary-text">{reasonLabel(r.reason)}</span>
                      <StatusBadge tone={statusTone(r.status)} size="sm">{statusText(r.status)}</StatusBadge>
                      {r.disposition === "ESCALATED" && <StatusBadge tone="critical" size="sm">Escalated</StatusBadge>}
                      {r.riskCount > 0 && <span className="inline-flex items-center gap-1 text-[11.5px] text-meta"><AlertTriangle className="size-3 text-status-warning" aria-hidden /> {r.riskCount} risk</span>}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <p className="mt-3 text-[11px] text-meta">
        Rows are real calls + SMS from Quo. Reason is calculated (heuristic) and human-overridable. &quot;Handled by AI&quot; never appears — Sona is not connected, so no call is AI-handled yet. A completed call is not a resolved issue; the outcome stays unknown unless we recorded one.
      </p>

      {/* Detail panel */}
      {selectedId && (
        cardLoading || !card ? (
          <div className="fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/50" onClick={() => setSelectedId(null)} aria-hidden />
            <div className="absolute inset-y-0 right-0 flex w-full max-w-[46rem] items-center justify-center bg-background">
              {cardLoading ? <Loader2 className="size-5 animate-spin text-meta" aria-hidden /> : <p className="text-[13px] text-meta">Couldn&apos;t load this call.</p>}
            </div>
          </div>
        ) : (
          <CallDetailPanel card={card} showMoney={showMoney} saving={saving} onClose={() => { setSelectedId(null); setCard(null); }} onReasonChange={changeReason} />
        )
      )}
    </BladeMain>
  );
}

// ── Contact vs context cells — distinct facets, both honest ──────────────────────────────────────────
// Contact = WHO is on the line (caller id / resolved name), with the identity-confidence state explicit.
function ContactCell({ r }: { r: QueueRow }): React.JSX.Element {
  const unknown = r.identityConfidence === "UNKNOWN";
  return (
    <div className="min-w-0">
      <div className={`truncate text-[13px] ${unknown ? "text-meta italic" : "text-foreground"}`}>{r.callerName}</div>
      {r.identityConfidence !== "CONFIRMED" ? (
        <StatusBadge tone={IDENTITY_TONE[r.identityConfidence]} size="sm" className="mt-0.5">{IDENTITY_LABEL[r.identityConfidence]}</StatusBadge>
      ) : (
        <div className="truncate text-[11px] text-meta">{fmtDuration(r.durationSec)}</div>
      )}
    </div>
  );
}

// Context = the matched CUSTOMER + event (a system fact, distinct from the caller). "Unmatched" is explicit.
function ContextCell({ r }: { r: QueueRow }): React.JSX.Element {
  if (!r.customerName) return <span className="text-[12.5px] text-meta">Unmatched</span>;
  return (
    <div className="min-w-0">
      <div className="truncate text-[12.5px] text-tertiary-text">{r.customerName}</div>
      {r.eventName && <div className="truncate text-[11px] text-meta">{r.eventName}</div>}
    </div>
  );
}

// ── Freshness ────────────────────────────────────────────────────────────────────────────────────────
function Freshness({ iso }: { iso: string }): React.JSX.Element {
  const d = new Date(iso);
  const label = isNaN(d.getTime()) ? "just now" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return <span>Updated {label}</span>;
}

// ── Toolbar / filter atoms ───────────────────────────────────────────────────────────────────────────
function Segmented({ ariaLabel, value, onChange, options }: { ariaLabel: string; value: string; onChange: (v: string) => void; options: [string, string][] }): React.JSX.Element {
  return (
    <div role="group" aria-label={ariaLabel} className="flex items-center gap-0.5 rounded border border-border p-0.5">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} aria-pressed={value === v} className={`rounded px-2.5 py-1 text-[12px] transition-colors ${value === v ? "bg-foreground/[0.08] text-foreground" : "text-meta hover:text-foreground"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

function ToolbarToggle({ active, onClick, children, ...rest }: { active?: boolean; onClick: () => void; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      {...rest}
      className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-[12.5px] transition-colors ${active ? "border-foreground/30 bg-foreground/[0.06] text-foreground" : "border-border text-tertiary-text hover:bg-row-hover hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

function FilterField({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">{label}</div>
      <div className="flex flex-wrap items-center gap-0.5 rounded border border-border p-0.5">
        {options.map(([v, l]) => (
          <button key={v} onClick={() => onChange(v)} aria-pressed={value === v} className={`rounded px-2 py-1 text-[12px] transition-colors ${value === v ? "bg-foreground/[0.08] text-foreground" : "text-meta hover:text-foreground"}`}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-row px-2 py-1 text-[11.5px] text-tertiary-text">
      {label}
      <button onClick={onRemove} aria-label={`Remove ${label} filter`} className="text-meta hover:text-foreground">
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}

function ColToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12.5px] text-tertiary-text">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 accent-[var(--foreground)]" />
      {label}
    </label>
  );
}

function SortTh({ label, onClick, children, ...rest }: { label: string; onClick: () => void; children?: React.ReactNode } & React.ThHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return (
    <th className={thCls} scope="col" {...rest}>
      <button onClick={onClick} className="inline-flex items-center gap-1 uppercase tracking-[0.08em] hover:text-foreground">
        {label} {children}
      </button>
    </th>
  );
}
