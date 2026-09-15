"use client";

// Sales OS — Kanban board. Cards are the pipeline leads, columns are the sales stages. Drag a card to
// another column to set its status (persisted via /api/salesos/lead-status; optimistic, reverts on
// failure). Archiving a card drops it off the board. Native HTML5 drag-and-drop — no library.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, GripVertical } from "lucide-react";
import type { BoardStatus, LeadCard } from "@/lib/salesos/boardTypes";
import { LeadSidePanel } from "@/components/LeadSidePanel";

const money = (n: number | null): string => (n == null ? "" : "$" + Math.round(n).toLocaleString("en-US"));

function whenLabel(dte: number | null): { text: string; hot: boolean } {
  if (dte == null) return { text: "no date", hot: false };
  if (dte < 0) return { text: `${Math.abs(dte)}d ago`, hot: false };
  if (dte === 0) return { text: "today", hot: true };
  if (dte === 1) return { text: "tomorrow", hot: true };
  return { text: `in ${dte}d`, hot: dte <= 14 };
}

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
  const [cards, setCards] = useState(initialCards);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<BoardStatus | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);

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
    <div className="h-[calc(100dvh-6rem)]">
      <div className="flex h-full items-start gap-3 overflow-auto p-4 md:p-5">
      {columns.map((col) => {
        const list = cards[col.key];
        const isOver = overCol === col.key;
        return (
          <div
            key={col.key}
            onDragOver={(e) => { e.preventDefault(); setOverCol(col.key); }}
            onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
            onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain") || dragId; if (id) moveTo(id, col.key); setOverCol(null); setDragId(null); }}
            className={`flex min-h-[120px] min-w-[200px] flex-1 flex-col border border-border bg-panel transition-colors ${isOver ? "border-foreground/30 bg-[var(--row-hover)]" : ""}`}
          >
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--row-rule)] bg-panel px-3 py-2.5">
              <span className={`text-[12px] font-medium uppercase tracking-[0.1em] ${col.key === "signed" ? "text-muted-foreground" : "text-tertiary-text"}`}>{col.label}</span>
              <span className="ml-auto text-[12px] tabular-nums text-meta">{list.length}</span>
            </div>
            <div className="space-y-1.5 p-1.5">
              {list.length === 0 && <p className="px-1 py-6 text-center text-[12px] text-meta">{isOver ? "Drop here" : "Empty"}</p>}
              {list.map((c) => {
                const w = whenLabel(c.daysToEvent);
                return (
                  <div
                    key={c.id}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; setDragId(c.id); }}
                    onDragEnd={() => { setDragId(null); setOverCol(null); }}
                    onClick={() => setDrawerId(c.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") setDrawerId(c.id); }}
                    className={`group cursor-pointer border border-border bg-card p-2.5 transition-colors hover:border-foreground/25 ${dragId === c.id ? "opacity-40" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      {showMoney && c.value != null && <span className="shrink-0 text-[15px] font-medium tabular-nums text-tertiary-text">{money(c.value)}</span>}
                      <span className={`ml-auto shrink-0 text-[12px] tabular-nums ${w.hot ? "text-critical" : "text-meta"}`}>{w.text}</span>
                      <button onClick={(e) => { e.stopPropagation(); archive(c.id); }} title="Archive (drop off the board)" className="-mr-0.5 shrink-0 rounded p-0.5 text-meta opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100">
                        <Archive className="size-3.5" />
                      </button>
                    </div>
                    <div className="mt-1 truncate text-[14px] font-medium text-foreground">{c.eventName || `Project ${c.id}`}</div>
                    <div className="flex items-center gap-1.5">
                      <GripVertical className="size-3 shrink-0 cursor-grab text-meta/60" />
                      <span className="truncate text-[12.5px] text-meta">{c.clientName || "Unknown client"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      </div>
      {drawerId && <LeadSidePanel id={drawerId} viewer={viewer} onClose={() => setDrawerId(null)} />}
    </div>
  );
}
