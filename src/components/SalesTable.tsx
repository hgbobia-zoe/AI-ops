"use client";

// Sales OS — Table view (client). Every pipeline lead in a GSPRO-style grid with a sensible default
// order (soonest event first), click-to-sort column headers, and clickable status pills that filter the
// table. The Sales OS heading + search + "Needs details" scope live in the shared shell header above; this
// view renders a compact scope/count line, the status filter pills, and the grid. Rows open the lead in
// the shared overlay side panel. Money columns are hidden for Members.

import { useState, useMemo } from "react";
import { ArrowUp, ArrowDown } from "lucide-react";
import { BOARD_COLUMNS, STATUS_LABEL, type BoardStatus, type LeadCard } from "@/lib/salesos/boardTypes";
import { matchesQuery, isIncompleteProject } from "@/lib/salesos/search";
import { SALES_STATUS_TONE, SALES_STATUS_ICON } from "@/lib/salesos/salesStatus";
import { STATUS_DOT } from "@/lib/tone";
import { StatusBadge } from "@/components/ui/status";
import { LeadSidePanel } from "@/components/LeadSidePanel";
import { SearchCount, useSalesSearch } from "@/components/SalesSearch";

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

const STATUS_ORDER: Record<string, number> = Object.fromEntries(BOARD_COLUMNS.map((c, i) => [c.key, i]));

type SortKey = "project" | "client" | "status" | "value" | "netPaid" | "remaining" | "quoteSent" | "eventDate" | "created";
const num = (n: number | null): number => (n == null ? -1 : n);

// Sortable header cell — a top-level component (not created during render) so its state never resets.
function Th({ k, label, right, sortKey, sortDir, onSort }: { k: SortKey; label: string; right?: boolean; sortKey: SortKey; sortDir: "asc" | "desc"; onSort: (k: SortKey) => void }): React.JSX.Element {
  const active = sortKey === k;
  return (
    <th className={`p-2.5 font-medium ${right ? "text-right" : "text-left"}`} aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
      <button onClick={() => onSort(k)} className={`inline-flex items-center gap-1 hover:text-foreground ${active ? "text-foreground" : ""} ${right ? "flex-row-reverse" : ""}`}>
        {label}
        {active && (sortDir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );
}

export function SalesTable({ cards, showMoney, viewer }: { cards: LeadCard[]; showMoney: boolean; viewer: { name: string; quoUserId: string | null; initials: string } }): React.JSX.Element {
  // The status chips drive the SAME shared state filter the header pills use on the other views, so a
  // selected state carries across the Board/Worklist/Table toggle (and the URL) as one source of truth.
  // The incomplete ("Needs details") scope is read from the shared context too, narrowing like search.
  const { query, stateFilter, setStateFilter, incompleteOnly } = useSalesSearch();
  const [sortKey, setSortKey] = useState<SortKey>("eventDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<string | null>(null);

  // The search + incomplete scope narrow the whole set first; the status chips (and their counts) then
  // act on what matches.
  const searched = useMemo(
    () =>
      cards.filter(
        (l) =>
          (!incompleteOnly || isIncompleteProject(l)) &&
          matchesQuery({ id: l.id, clientName: l.clientName, eventName: l.eventName, value: l.value, stage: STATUS_LABEL[l.status], venue: l.venue, location: l.location }, query),
      ),
    [cards, query, incompleteOnly],
  );
  const counts = useMemo(() => Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, searched.filter((l) => l.status === c.key).length])), [searched]);
  const narrowing = query.trim().length > 0 || incompleteOnly;

  const rows = useMemo(() => {
    const filtered = stateFilter ? searched.filter((l) => l.status === stateFilter) : searched;
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
  }, [searched, stateFilter, sortKey, sortDir]);

  const sort = (k: SortKey): void => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "value" || k === "netPaid" || k === "remaining" ? "desc" : "asc"); }
  };

  const colCount = showMoney ? 9 : 6;

  return (
    <main className="p-4 md:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-secondary-text">
        {narrowing ? <SearchCount shown={searched.length} total={cards.length} /> : <span className="tabular-nums">{cards.length}</span>}
        <span>{narrowing ? "matching" : cards.length === 1 ? "open lead" : "open leads"} · click a status to filter, a column to sort.</span>
      </div>

      {/* Status filters — neutral pills with a status-coloured dot + count (colour on the dot, never the label). */}
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          onClick={() => setStateFilter(null)}
          aria-pressed={stateFilter === null}
          className={`rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${stateFilter === null ? "border-foreground/40 bg-foreground/10 text-foreground" : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"}`}
        >
          All <span className="tabular-nums">{searched.length}</span>
        </button>
        {BOARD_COLUMNS.map((c) => {
          const on = stateFilter === c.key;
          return (
            <button
              key={c.key}
              onClick={() => setStateFilter(on ? null : c.key)}
              aria-pressed={on}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${on ? "border-foreground/40 bg-foreground/10 text-foreground" : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"}`}
            >
              <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[SALES_STATUS_TONE[c.key]]}`} aria-hidden />
              {c.label} <span className="tabular-nums">{counts[c.key as BoardStatus]}</span>
            </button>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[900px] text-[13px]">
          <thead>
            <tr className="border-b border-rule text-[10.5px] uppercase tracking-[0.06em] text-meta">
              <Th k="project" label="Project" sortKey={sortKey} sortDir={sortDir} onSort={sort} />
              <Th k="client" label="Client" sortKey={sortKey} sortDir={sortDir} onSort={sort} />
              <Th k="status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={sort} />
              {showMoney && <Th k="value" label="Quote total" right sortKey={sortKey} sortDir={sortDir} onSort={sort} />}
              {showMoney && <Th k="netPaid" label="Net paid" right sortKey={sortKey} sortDir={sortDir} onSort={sort} />}
              {showMoney && <Th k="remaining" label="Remaining" right sortKey={sortKey} sortDir={sortDir} onSort={sort} />}
              <Th k="quoteSent" label="Quote sent" sortKey={sortKey} sortDir={sortDir} onSort={sort} />
              <Th k="eventDate" label="Event date" sortKey={sortKey} sortDir={sortDir} onSort={sort} />
              <Th k="created" label="Created" sortKey={sortKey} sortDir={sortDir} onSort={sort} />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--row-rule)]">
            {rows.length === 0 ? (
              <tr><td colSpan={colCount} className="p-8 text-center text-muted-foreground">{narrowing ? `No projects match${query.trim() ? ` “${query.trim()}”` : ""}${stateFilter ? " in this status" : ""}${incompleteOnly ? " needing details" : ""}.` : `No leads${stateFilter ? " in this status" : ""}.`}</td></tr>
            ) : (
              rows.map((l) => {
                const title = l.eventName?.trim() || `Project ${l.id}`;
                return (
                  <tr
                    key={l.id}
                    onClick={() => setSelected(l.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(l.id); } }}
                    role="button"
                    tabIndex={0}
                    aria-current={selected === l.id ? "true" : undefined}
                    aria-label={`${title}, ${l.clientName || "unknown client"}, ${STATUS_LABEL[l.status]}`}
                    className={`cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected === l.id ? "bg-lifted" : "hover:bg-[var(--row-hover)]"}`}
                  >
                    <td className="p-2.5 font-medium text-foreground">{title}</td>
                    <td className="p-2.5 text-secondary-text">{l.clientName || "—"}</td>
                    <td className="p-2.5"><StatusBadge tone={SALES_STATUS_TONE[l.status]} icon={SALES_STATUS_ICON[l.status]} size="sm">{STATUS_LABEL[l.status]}</StatusBadge></td>
                    {showMoney && <td className="p-2.5 text-right tabular-nums text-foreground">{money(l.value)}</td>}
                    {showMoney && <td className="p-2.5 text-right tabular-nums text-secondary-text">{money(l.netPaid)}</td>}
                    {showMoney && <td className="p-2.5 text-right tabular-nums text-secondary-text">{money(l.remainingBalance)}</td>}
                    <td className="p-2.5 text-secondary-text">{shortDate(l.quoteSentDate)}</td>
                    <td className="p-2.5 text-secondary-text">{shortDate(l.eventDate)}</td>
                    <td className="p-2.5 text-secondary-text">{shortDate(l.dateCreated)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {selected && <LeadSidePanel id={selected} viewer={viewer} onClose={() => setSelected(null)} />}
    </main>
  );
}
