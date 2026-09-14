"use client";

// Sales OS — Kanban board. Cards are the pipeline leads, columns are the sales stages. Drag a card to
// another column to set its status (persisted via /api/salesos/lead-status; optimistic, reverts on
// failure). Archiving a card drops it off the board. Native HTML5 drag-and-drop — no library.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Archive, GripVertical } from "lucide-react";
import type { BoardStatus, LeadCard } from "@/lib/salesos/boardTypes";

const money = (n: number | null): string => (n == null ? "" : "$" + Math.round(n).toLocaleString("en-US"));

const COL_ACCENT: Record<BoardStatus, string> = {
  new: "border-t-amber-500/60",
  quote_sent: "border-t-sky-500/60",
  follow_up: "border-t-violet-500/60",
  action_needed: "border-t-rose-500/60",
  signed: "border-t-emerald-500/60",
};

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
}: {
  columns: { key: BoardStatus; label: string }[];
  initialCards: Record<BoardStatus, LeadCard[]>;
  showMoney: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [cards, setCards] = useState(initialCards);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<BoardStatus | null>(null);

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
    <div className="flex h-[calc(100dvh-3.25rem)] gap-3 overflow-x-auto p-4 md:p-5">
      {columns.map((col) => {
        const list = cards[col.key];
        const isOver = overCol === col.key;
        return (
          <div
            key={col.key}
            onDragOver={(e) => { e.preventDefault(); setOverCol(col.key); }}
            onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
            onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain") || dragId; if (id) moveTo(id, col.key); setOverCol(null); setDragId(null); }}
            className={`flex h-full min-w-72 flex-1 flex-col rounded-xl border border-t-2 bg-white/[0.02] ${COL_ACCENT[col.key]} ${isOver ? "border-white/30 bg-white/[0.05]" : "border-white/10"}`}
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2.5">
              <span className="text-sm font-semibold">{col.label}</span>
              <span className="rounded-full bg-white/[0.08] px-1.5 text-xs tabular-nums text-muted-foreground">{list.length}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {list.length === 0 && <p className="px-1 py-6 text-center text-xs text-muted-foreground">{isOver ? "Drop here" : "Empty"}</p>}
              {list.map((c) => {
                const w = whenLabel(c.daysToEvent);
                return (
                  <div
                    key={c.id}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; setDragId(c.id); }}
                    onDragEnd={() => { setDragId(null); setOverCol(null); }}
                    className={`group rounded-lg border border-white/10 bg-background p-2.5 shadow-sm transition-opacity ${dragId === c.id ? "opacity-40" : ""}`}
                  >
                    <div className="flex items-start gap-1.5">
                      <GripVertical className="mt-0.5 size-3.5 shrink-0 cursor-grab text-muted-foreground/50" />
                      <div className="min-w-0 flex-1">
                        <Link href={`/salesos/${c.id}`} className="block truncate text-sm font-medium hover:underline">{c.eventName || `Project ${c.id}`}</Link>
                        <div className="truncate text-[11px] text-muted-foreground">{c.clientName || "Unknown client"}</div>
                      </div>
                      <button onClick={() => archive(c.id)} title="Archive (drop off the board)" className="shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100">
                        <Archive className="size-3.5" />
                      </button>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 pl-5 text-[11px]">
                      <span className={w.hot ? "text-rose-200" : "text-muted-foreground"}>{w.text}</span>
                      {showMoney && c.value != null && <span className="ml-auto tabular-nums text-amber-200">{money(c.value)}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
