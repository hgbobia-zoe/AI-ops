"use client";

// Sales OS — Kanban board. Cards are the pipeline leads, columns are the sales stages. Drag a card to
// another column to set its status (persisted via /api/salesos/lead-status; optimistic, reverts on
// failure). Every card also has a keyboard-accessible "Move" control (the equivalent of the drag, for
// keyboard/AT users) and an Archive control. Archiving a card drops it off the board. Native HTML5
// drag-and-drop — no library.
//
// Each column scrolls vertically inside its own bounded box, so a long stage never makes the others
// unusable; the whole board scrolls horizontally inside one bounded container (the page never scrolls
// sideways). Clicking/Enter/Space on a card opens the full lead in the shared overlay side panel.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, GripVertical, AlertTriangle } from "lucide-react";
import { STATUS_LABEL, type BoardStatus, type LeadStatus, type LeadCard } from "@/lib/salesos/boardTypes";
import { matchesQuery, matchesState, isIncompleteProject, relativeEvent } from "@/lib/salesos/search";
import { SALES_STATUS_TONE } from "@/lib/salesos/salesStatus";
import { STATUS_INDICATOR } from "@/lib/tone";
import { LeadSidePanel } from "@/components/LeadSidePanel";
import { SearchCount, useSalesSearch } from "@/components/SalesSearch";

const money = (n: number | null): string => (n == null ? "" : "$" + Math.round(n).toLocaleString("en-US"));

const shortDate = (ymd: string | null): string | null => {
  if (!ymd) return null;
  const d = new Date(ymd.length > 10 ? ymd : `${ymd}T00:00:00`);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export function SalesBoard({
  columns,
  initialCards,
  showMoney,
  viewer,
}: {
  columns: { key: BoardStatus; label: string }[];
  initialCards: Record<BoardStatus, LeadCard[]>;
  showMoney: boolean;
  viewer: { name: string; quoUserId: string | null; initials: string };
}): React.JSX.Element {
  const router = useRouter();
  const { query, stateFilter, incompleteOnly } = useSalesSearch();
  const [cards, setCards] = useState(initialCards);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<BoardStatus | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);

  // Search, state filter and the incomplete scope narrow what's SHOWN (a derived view); drag/drop/archive
  // still operate on the full `cards` state, so moving a card works and column counts stay honest to what's
  // on screen. The board NEVER collapses — all columns always render (Jira-style). A state filter is applied
  // PER CARD against the card's own board status, so only the matching column keeps cards and the rest empty.
  const visible = useMemo(() => {
    const out = {} as Record<BoardStatus, LeadCard[]>;
    for (const col of columns) {
      out[col.key] = cards[col.key].filter(
        (c) =>
          matchesState(c.status, stateFilter) &&
          (!incompleteOnly || isIncompleteProject(c)) &&
          matchesQuery({ id: c.id, clientName: c.clientName, eventName: c.eventName, value: c.value, stage: STATUS_LABEL[c.status], venue: c.venue, location: c.location }, query),
      );
    }
    return out;
  }, [cards, columns, query, stateFilter, incompleteOnly]);
  const total = useMemo(() => columns.reduce((n, col) => n + cards[col.key].length, 0), [cards, columns]);
  const shown = useMemo(() => columns.reduce((n, col) => n + visible[col.key].length, 0), [columns, visible]);
  const incompleteCount = useMemo(() => columns.reduce((n, col) => n + cards[col.key].filter(isIncompleteProject).length, 0), [cards, columns]);
  const searching = query.trim().length > 0 || stateFilter !== null || incompleteOnly;

  async function persist(id: string, status: BoardStatus | "archived"): Promise<void> {
    try {
      const r = await fetch("/api/salesos/lead-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status }) });
      if (!r.ok) throw new Error("failed");
    } catch {
      router.refresh(); // revert to server truth on failure
    }
  }

  function findCard(id: string): { card: LeadCard; from: BoardStatus } | null {
    for (const col of columns) {
      const card = cards[col.key].find((c) => c.id === id);
      if (card) return { card, from: col.key };
    }
    return null;
  }

  function moveTo(id: string, to: BoardStatus): void {
    const found = findCard(id);
    if (!found || found.from === to) return;
    setCards((prev) => {
      const next = { ...prev };
      next[found.from] = prev[found.from].filter((c) => c.id !== id);
      next[to] = [{ ...found.card, status: to }, ...prev[to]];
      return next;
    });
    void persist(id, to);
  }

  function archive(id: string): void {
    const found = findCard(id);
    if (!found) return;
    setCards((prev) => ({ ...prev, [found.from]: prev[found.from].filter((c) => c.id !== id) }));
    void persist(id, "archived");
  }

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 md:px-5">
        <span className="text-[12.5px] text-secondary-text">
          {searching ? <SearchCount shown={shown} total={total} /> : <span className="tabular-nums">{total}</span>} {searching ? "matching" : total === 1 ? "project" : "projects"} across {columns.length} stages
        </span>
        {!incompleteOnly && incompleteCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[12px] text-meta">
            <AlertTriangle className={`size-3 ${STATUS_INDICATOR.attention}`} aria-hidden />
            {incompleteCount} need details
          </span>
        )}
      </div>

      {searching && shown === 0 ? (
        <p className="px-6 py-16 text-center text-[13.5px] text-muted-foreground">
          {query.trim() ? (
            <>No projects match &ldquo;{query.trim()}&rdquo;{stateFilter ? " in this state" : ""}{incompleteOnly ? " needing details" : ""}.</>
          ) : incompleteOnly ? (
            "No incomplete projects on the board."
          ) : (
            "No projects in this state."
          )}
        </p>
      ) : (
        <div className="flex min-w-0 items-start gap-3 overflow-x-auto p-4 md:p-5">
          {columns.map((col) => {
            const list = visible[col.key];
            const isOver = overCol === col.key;
            return (
              <section
                key={col.key}
                aria-label={`${col.label} (${list.length})`}
                onDragOver={(e) => { e.preventDefault(); setOverCol(col.key); }}
                onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
                onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain") || dragId; if (id) moveTo(id, col.key); setOverCol(null); setDragId(null); }}
                className={`flex max-h-[72dvh] w-[260px] shrink-0 flex-col border border-border bg-panel transition-colors ${isOver ? "border-foreground/30 bg-[var(--row-hover)]" : ""}`}
              >
                <div className="flex items-center gap-2 border-b border-[var(--row-rule)] bg-panel px-3 py-2.5">
                  <span className={`text-[12px] font-medium uppercase tracking-[0.1em] ${col.key === "signed" ? "text-muted-foreground" : "text-tertiary-text"}`}>{col.label}</span>
                  <span className="ml-auto text-[12px] tabular-nums text-meta">{list.length}</span>
                </div>
                <div className="min-h-[88px] flex-1 space-y-1.5 overflow-y-auto p-1.5">
                  {list.length === 0 && <p className="px-1 py-6 text-center text-[12px] text-meta">{isOver ? "Drop here" : searching ? "No match" : "Empty"}</p>}
                  {list.map((c) => (
                    <BoardCard
                      key={c.id}
                      card={c}
                      columns={columns}
                      showMoney={showMoney}
                      dragging={dragId === c.id}
                      onOpen={() => setDrawerId(c.id)}
                      onDragStart={(e) => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; setDragId(c.id); }}
                      onDragEnd={() => { setDragId(null); setOverCol(null); }}
                      onMove={(to) => moveTo(c.id, to)}
                      onArchive={() => archive(c.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {drawerId && <LeadSidePanel id={drawerId} viewer={viewer} onClose={() => setDrawerId(null)} />}
    </div>
  );
}

function BoardCard({
  card: c,
  columns,
  showMoney,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  onMove,
  onArchive,
}: {
  card: LeadCard;
  columns: { key: BoardStatus; label: string }[];
  showMoney: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onMove: (to: BoardStatus) => void;
  onArchive: () => void;
}): React.JSX.Element {
  const w = relativeEvent(c.daysToEvent);
  const title = c.eventName?.trim() || `Project ${c.id}`;
  const date = shortDate(c.eventDate);
  const incomplete = isIncompleteProject(c);
  const tone = SALES_STATUS_TONE[c.status];

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      aria-label={`${title}, ${c.clientName || "unknown client"}${showMoney && c.value != null ? `, ${money(c.value)}` : ""}${date ? `, event ${date}` : ", no event date"}`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className={`group border border-border bg-card p-2.5 transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${dragging ? "opacity-40" : ""}`}
    >
      <div className="flex items-start gap-2">
        {showMoney ? (
          c.value != null ? (
            <span className="shrink-0 text-[15px] font-medium tabular-nums text-foreground">{money(c.value)}</span>
          ) : (
            <span className="shrink-0 text-[12px] text-meta">No amount</span>
          )
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <MoveMenu columns={columns} current={c.status} onMove={onMove} />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onArchive(); }}
            title="Archive (drop off the board)"
            aria-label={`Archive ${title}`}
            className="rounded p-0.5 text-meta opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
          >
            <Archive className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Two-line readable title — wraps, never truncated to a stub; full title is the card's aria-label + title. */}
      <div className="mt-1 line-clamp-2 break-words text-[14px] font-medium leading-snug text-foreground" title={title}>{title}</div>

      <div className="mt-0.5 flex items-center gap-1.5">
        <GripVertical className="size-3 shrink-0 cursor-grab text-meta/60" aria-hidden />
        <span className="truncate text-[12.5px] text-meta">{c.clientName || "Unknown client"}</span>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[12px]">
        <span className={`tabular-nums ${w.urgent ? "text-critical" : "text-tertiary-text"}`}>
          {date ? <>{date} · {w.text}</> : "No event date"}
        </span>
        {incomplete ? (
          <span className="inline-flex items-center gap-1 text-meta"><AlertTriangle className={`size-3 ${STATUS_INDICATOR.attention}`} aria-hidden /> Needs details</span>
        ) : c.statusLabel ? (
          <span className={`inline-flex items-center gap-1 ${STATUS_INDICATOR[tone]}`} title={`Goodshuffle: ${c.statusLabel}`}>
            <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
            <span className="max-w-[88px] truncate text-meta">{c.statusLabel}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

// The keyboard-accessible equivalent of dragging: a native <select> of the other stages. A native select
// is operable by keyboard out of the box AND renders its option list in the browser's own layer, so it is
// never clipped by the column's own scroll box (a positioned dropdown would be). Its events are stopped
// from bubbling so focusing/opening/choosing never also triggers the card's open-drawer handler.
function MoveMenu({ columns, current, onMove }: { columns: { key: BoardStatus; label: string }[]; current: LeadStatus; onMove: (to: BoardStatus) => void }): React.JSX.Element {
  const targets = columns.filter((col) => col.key !== current);
  return (
    <select
      aria-label="Move this lead to another stage"
      title="Move to another stage"
      value=""
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => { const to = e.target.value as BoardStatus; if (to) onMove(to); e.currentTarget.value = ""; }}
      className="w-14 cursor-pointer rounded border border-border bg-panel px-1 py-0.5 text-[11px] text-meta opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
    >
      <option value="" disabled>Move</option>
      {targets.map((col) => (
        <option key={col.key} value={col.key}>{col.label}</option>
      ))}
    </select>
  );
}
