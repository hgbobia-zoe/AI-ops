"use client";

// Sales OS — Table view (client). Every pipeline lead in a GSPRO-style grid with a sensible default
// order (soonest event first), click-to-sort column headers, and clickable status pills that filter
// the table. Rows open the lead in the worklist detail.

import { useState, useMemo } from "react";
import { ArrowUp, ArrowDown } from "lucide-react";
import { BOARD_COLUMNS, STATUS_LABEL, type LeadCard } from "@/lib/salesos/boardTypes";
import { LeadSidePanel } from "@/components/LeadSidePanel";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const shortDate = (ymd: string | null): string => {
  if (!ymd) return "—";
  const d = new Date(ymd.length > 10 ? ymd : `${ymd}T00:00:00`);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const ts = (ymd: string | null): number => {
  if (!ymd) return Number.POSITIVE_INFINITY; // undated sort last on asc
  const t = Date.parse(ymd.length > 10 ? ymd : `${ymd}T00:00:00`);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

const STATUS_CHIP: Record<string, string> = {
  new: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  quote_sent: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  follow_up: "border-violet-500/40 bg-violet-500/10 text-violet-200",
  action_needed: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  signed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  archived: "border-white/15 bg-white/5 text-muted-foreground",
};
const STATUS_ORDER: Record<string, number> = Object.fromEntries(BOARD_COLUMNS.map((c, i) => [c.key, i]));

type SortKey = "project" | "client" | "status" | "value" | "netPaid" | "remaining" | "quoteSent" | "eventDate" | "created";
const num = (n: number | null): number => (n == null ? -1 : n);

export function SalesTable({ cards, showMoney, viewer }: { cards: LeadCard[]; showMoney: boolean; viewer: { name: string; quoUserId: string | null; initials: string } }): React.JSX.Element {
  const [filter, setFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("eventDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<string | null>(null);

  const counts = useMemo(() => Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, cards.filter((l) => l.status === c.key).length])), [cards]);

  const rows = useMemo(() => {
    const filtered = filter ? cards.filter((l) => l.status === filter) : cards;
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (l: LeadCard): number | string => {
      switch (sortKey) {
        case "project": return (l.eventName || "").toLowerCase();
        case "client": return (l.clientName || "").toLowerCase();
        case "status": return STATUS_ORDER[l.status] ?? 99;
        case "value": return num(l.value);
        case "netPaid": return num(l.netPaid);
        case "remaining": return num(l.remainingBalance);
        case "quoteSent": return ts(l.quoteSentDate);
        case "eventDate": return ts(l.eventDate);
        case "created": return ts(l.dateCreated);
      }
    };
    return [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [cards, filter, sortKey, sortDir]);

  const sort = (k: SortKey): void => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "value" || k === "netPaid" || k === "remaining" ? "desc" : "asc"); }
  };

  const Th = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }): React.JSX.Element => (
    <th className={`p-2.5 ${right ? "text-right" : "text-left"}`}>
      <button onClick={() => sort(k)} className={`inline-flex items-center gap-1 hover:text-foreground ${sortKey === k ? "text-foreground" : ""} ${right ? "flex-row-reverse" : ""}`}>
        {label}
        {sortKey === k && (sortDir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );

  return (
    <main className="p-5 md:p-6">
      <header className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
        <p className="text-sm text-muted-foreground">{cards.length} open {cards.length === 1 ? "lead" : "leads"} · click a status to filter, a column to sort.</p>
      </header>

      {/* Clickable status filters */}
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          onClick={() => setFilter(null)}
          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${filter === null ? "border-white/40 bg-white/10 text-foreground" : "border-white/15 text-muted-foreground hover:text-foreground"}`}
        >
          All <span className="tabular-nums">{cards.length}</span>
        </button>
        {BOARD_COLUMNS.map((c) => {
          const on = filter === c.key;
          return (
            <button
              key={c.key}
              onClick={() => setFilter(on ? null : c.key)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${STATUS_CHIP[c.key]} ${on ? "ring-1 ring-white/40" : "opacity-80 hover:opacity-100"}`}
            >
              {c.label} <span className="tabular-nums">{counts[c.key]}</span>
            </button>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-[11px] uppercase tracking-wide text-muted-foreground">
              <Th k="project" label="Project" />
              <Th k="client" label="Client" />
              <Th k="status" label="Status" />
              {showMoney && <Th k="value" label="Quote total" right />}
              {showMoney && <Th k="netPaid" label="Net paid" right />}
              {showMoney && <Th k="remaining" label="Remaining" right />}
              <Th k="quoteSent" label="Quote sent" />
              <Th k="eventDate" label="Event date" />
              <Th k="created" label="Created" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.length === 0 ? (
              <tr><td colSpan={showMoney ? 9 : 6} className="p-8 text-center text-muted-foreground">No leads{filter ? " in this status" : ""}.</td></tr>
            ) : (
              rows.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => setSelected(l.id)}
                  aria-current={selected === l.id ? "true" : undefined}
                  className={`cursor-pointer transition-colors ${selected === l.id ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}
                >
                  <td className="p-2.5 font-medium">{l.eventName || `Project ${l.id}`}</td>
                  <td className="p-2.5 text-muted-foreground">{l.clientName || "—"}</td>
                  <td className="p-2.5"><span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CHIP[l.status]}`}>{STATUS_LABEL[l.status]}</span></td>
                  {showMoney && <td className="p-2.5 text-right tabular-nums">{money(l.value)}</td>}
                  {showMoney && <td className="p-2.5 text-right tabular-nums text-emerald-200">{money(l.netPaid)}</td>}
                  {showMoney && <td className="p-2.5 text-right tabular-nums text-amber-200">{money(l.remainingBalance)}</td>}
                  <td className="p-2.5 text-muted-foreground">{shortDate(l.quoteSentDate)}</td>
                  <td className="p-2.5 text-muted-foreground">{shortDate(l.eventDate)}</td>
                  <td className="p-2.5 text-muted-foreground">{shortDate(l.dateCreated)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selected && <LeadSidePanel id={selected} viewer={viewer} onClose={() => setSelected(null)} />}
    </main>
  );
}
