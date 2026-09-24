"use client";

// The Communications queue — the operating desk. Real rows from real calls + SMS (the live Quo feed),
// enriched with the calculated reason, matched customer/event, identity confidence and open risk.
// Sortable + filterable (handled-by / disposition / desk / day), with a Nocturne table and the app-wide
// side panel for detail. Reads like a dispatch board, not a chatbot.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Headset, RefreshCw, Loader2, PhoneIncoming, PhoneOutgoing, MessageSquare, ArrowUp, ArrowDown } from "lucide-react";
import { tableCls, theadCls, thCls, tdCls, rowCls, FigureStrip, StatusMark } from "@/components/console-primitives";
import { REASON_DESK } from "@/lib/comms/reasons";
import type { QueueRow, CallCard } from "@/lib/comms/types";
import { CallDetailPanel } from "./CallDetailPanel";
import { fmtWhen, fmtDuration, reasonLabel, IDENTITY_LABEL } from "./helpers";

type SortKey = "time" | "caller" | "reason" | "risk";
interface Filters {
  handled: "" | "AI" | "HUMAN" | "TRANSFERRED";
  disposition: "" | "UNRESOLVED" | "ESCALATED";
  desk: "" | "SALES" | "OPERATIONS" | "BILLING";
  day: "" | "today" | "yesterday";
}

const EMPTY: Filters = { handled: "", disposition: "", desk: "", day: "" };

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function CommsQueue({ showMoney }: { showMoney: boolean }): React.JSX.Element {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
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
      .then((j: { rows: QueueRow[] }) => { if (alive) setRows(j.rows ?? []); })
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

  const filtered = useMemo(() => {
    let out = (rows ?? []).filter((r) => {
      if (filters.handled && r.handledBy !== filters.handled) return false;
      if (filters.disposition === "ESCALATED" && r.disposition !== "ESCALATED") return false;
      if (filters.disposition === "UNRESOLVED" && r.disposition !== "UNKNOWN") return false;
      if (filters.desk && REASON_DESK[r.reason] !== filters.desk) return false;
      if (filters.day) {
        const d = (r.occurredAt ?? r.ts).slice(0, 10);
        if (filters.day === "today" && d !== today) return false;
        if (filters.day === "yesterday" && d !== yesterday) return false;
      }
      if (q.trim()) {
        const hay = `${r.callerName} ${r.callerPhone ?? ""} ${r.customerName ?? ""} ${r.eventName ?? ""}`.toLowerCase();
        if (!hay.includes(q.trim().toLowerCase())) return false;
      }
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      if (sortKey === "caller") return dir * a.callerName.localeCompare(b.callerName);
      if (sortKey === "reason") return dir * reasonLabel(a.reason).localeCompare(reasonLabel(b.reason));
      if (sortKey === "risk") return dir * (a.riskCount - b.riskCount);
      return dir * ((Date.parse(a.occurredAt ?? a.ts) || 0) - (Date.parse(b.occurredAt ?? b.ts) || 0));
    });
    return out;
  }, [rows, filters, q, sortKey, sortDir, today, yesterday]);

  const figures = useMemo(() => {
    const all = rows ?? [];
    return [
      { label: "In view", value: filtered.length },
      { label: "Escalated", value: all.filter((r) => r.disposition === "ESCALATED").length, tone: "critical" as const, sep: true },
      { label: "Unidentified", value: all.filter((r) => r.identityConfidence === "UNKNOWN").length, tone: "attention" as const },
      { label: "Today", value: all.filter((r) => (r.occurredAt ?? r.ts).slice(0, 10) === today).length, sep: true },
    ];
  }, [rows, filtered.length, today]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "caller" || k === "reason" ? "asc" : "desc"); }
  };
  const sortIcon = (k: SortKey): React.ReactNode => (sortKey !== k ? null : sortDir === "asc" ? <ArrowUp className="inline size-3" /> : <ArrowDown className="inline size-3" />);

  return (
    <main className="p-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
            <Headset className="size-5 text-meta" /> Communications
          </h1>
          <p className="mt-1 text-[13px] text-meta">Voice, SMS &amp; Customer Interaction Operations</p>
        </div>
        <button onClick={refresh} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </header>

      <div className="mb-4 rounded border border-border p-3">
        <FigureStrip figures={figures} />
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ChipGroup label="Handled" value={filters.handled} onChange={(v) => setFilters((f) => ({ ...f, handled: v as Filters["handled"] }))} options={[["", "All"], ["AI", "AI"], ["HUMAN", "Human"], ["TRANSFERRED", "Transferred"]]} />
        <ChipGroup label="State" value={filters.disposition} onChange={(v) => setFilters((f) => ({ ...f, disposition: v as Filters["disposition"] }))} options={[["", "Any"], ["UNRESOLVED", "Unresolved"], ["ESCALATED", "Escalated"]]} />
        <ChipGroup label="Desk" value={filters.desk} onChange={(v) => setFilters((f) => ({ ...f, desk: v as Filters["desk"] }))} options={[["", "All"], ["SALES", "Sales"], ["OPERATIONS", "Operations"], ["BILLING", "Billing"]]} />
        <ChipGroup label="When" value={filters.day} onChange={(v) => setFilters((f) => ({ ...f, day: v as Filters["day"] }))} options={[["", "All"], ["today", "Today"], ["yesterday", "Yesterday"]]} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search caller, phone, event…"
          className="ml-auto w-56 rounded border border-border bg-[var(--row)] px-2.5 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/40"
        />
      </div>

      {/* Table */}
      {loading || rows === null ? (
        <div className="flex items-center gap-2 py-10 text-[13px] text-meta"><Loader2 className="size-4 animate-spin" /> Loading the queue…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded border border-border p-8 text-center text-[13px] text-meta">
          {(rows ?? []).length === 0 ? "No calls or messages yet — they arrive from Quo as they happen." : "No rows match these filters."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className={tableCls} style={{ minWidth: 980 }}>
            <colgroup>
              <col style={{ width: 108 }} /><col style={{ width: 150 }} /><col style={{ width: 140 }} /><col style={{ width: 150 }} />
              <col style={{ width: 130 }} /><col style={{ width: 64 }} /><col style={{ width: 84 }} /><col style={{ width: 92 }} />
              <col style={{ width: 96 }} /><col style={{ width: 56 }} />
            </colgroup>
            <thead className={theadCls}>
              <tr>
                <th className={`${thCls} cursor-pointer`} onClick={() => toggleSort("time")}>Time {sortIcon("time")}</th>
                <th className={`${thCls} cursor-pointer`} onClick={() => toggleSort("caller")}>Caller {sortIcon("caller")}</th>
                <th className={thCls}>Customer</th>
                <th className={thCls}>Event</th>
                <th className={`${thCls} cursor-pointer`} onClick={() => toggleSort("reason")}>Reason {sortIcon("reason")}</th>
                <th className={thCls}>Chan</th>
                <th className={thCls}>Handled</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Disp.</th>
                <th className={`${thCls} cursor-pointer text-right`} onClick={() => toggleSort("risk")}>Risk {sortIcon("risk")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const Dir = r.channel === "sms" ? MessageSquare : r.direction === "outgoing" ? PhoneOutgoing : PhoneIncoming;
                return (
                  <tr key={r.id} onClick={() => openCard(r.id)} className={`${rowCls} cursor-pointer ${selectedId === r.id ? "bg-[var(--row-hover)]" : ""}`}>
                    <td className={`${tdCls} whitespace-nowrap text-[12px] text-meta`}>{fmtWhen(r.occurredAt ?? r.ts)}</td>
                    <td className={tdCls}>
                      <div className="truncate text-foreground">{r.callerName}</div>
                      <div className="truncate text-[11px] text-meta">{r.identityConfidence !== "CONFIRMED" ? IDENTITY_LABEL[r.identityConfidence] : fmtDuration(r.durationSec)}</div>
                    </td>
                    <td className={`${tdCls} truncate ${r.customerName ? "text-tertiary-text" : "text-meta"}`}>{r.customerName ?? "—"}</td>
                    <td className={`${tdCls} truncate ${r.eventName ? "text-tertiary-text" : "text-meta"}`}>{r.eventName ?? "—"}</td>
                    <td className={`${tdCls} truncate text-[12.5px] text-tertiary-text`}>{reasonLabel(r.reason)}</td>
                    <td className={tdCls}><Dir className="size-3.5 text-meta" /></td>
                    <td className={`${tdCls} text-[12px] ${r.handledBy === "HUMAN" ? "text-tertiary-text" : "text-meta"}`}>{r.handledBy === "HUMAN" ? "Human" : r.handledBy === "AI" ? "AI" : r.handledBy === "TRANSFERRED" ? "Transf." : "—"}</td>
                    <td className={tdCls}><StatusMark tone={r.status === "COMPLETED" ? "positive" : r.status === "MISSED" ? "critical" : "attention"} label={r.status[0] + r.status.slice(1).toLowerCase()} /></td>
                    <td className={`${tdCls} text-[12px] ${r.disposition === "ESCALATED" ? "text-critical" : "text-meta"}`}>{r.disposition === "ESCALATED" ? "Escalated" : "—"}</td>
                    <td className={`${tdCls} text-right tabular-nums ${r.riskCount > 0 ? "text-attention" : "text-meta"}`}>{r.riskCount || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11px] text-meta">
        Rows are real calls + SMS from Quo. Reason is calculated (heuristic) and human-overridable. &quot;Handled by AI&quot; never appears — Sona is not connected, so no call is AI-handled yet.
      </p>

      {/* Detail panel */}
      {selectedId && (
        cardLoading || !card ? (
          <div className="fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/50" onClick={() => setSelectedId(null)} aria-hidden />
            <div className="absolute inset-y-0 right-0 flex w-full max-w-[46rem] items-center justify-center bg-background">
              {cardLoading ? <Loader2 className="size-5 animate-spin text-meta" /> : <p className="text-[13px] text-meta">Couldn&apos;t load this call.</p>}
            </div>
          </div>
        ) : (
          <CallDetailPanel card={card} showMoney={showMoney} saving={saving} onClose={() => { setSelectedId(null); setCard(null); }} onReasonChange={changeReason} />
        )
      )}
    </main>
  );
}

function ChipGroup({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 rounded border border-border p-0.5">
      <span className="px-1.5 text-[10.5px] uppercase tracking-[0.08em] text-meta">{label}</span>
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className={`rounded px-2 py-1 text-[12px] transition-colors ${value === v ? "bg-foreground/[0.08] text-foreground" : "text-meta hover:text-foreground"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}
