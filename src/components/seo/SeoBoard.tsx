"use client";

// SEO Growth — opportunity Kanban. Columns are the lifecycle stages (stages.ts BOARD_STAGES); drag a card to
// another column to move its stage. The move is GUARDED server-side by the transition map: an illegal drop is
// rejected and the board reverts to server truth. Clicking a card opens the detail in the shared side panel.
// Native HTML5 drag-and-drop — no library (mirrors SalesBoard).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GripVertical } from "lucide-react";
import { BOARD_STAGES, STAGE_META, canTransition } from "@/lib/seo/stages";
import type { SeoOpportunity, SeoStage } from "@/lib/seo/types";

const ACTION_TONE: Record<string, string> = {
  CREATE: "text-[color:var(--positive,#16a34a)]",
  IMPROVE: "text-attention",
  CONSOLIDATE: "text-foreground",
  SKIP: "text-meta",
};

function priorityTone(n: number | null): string {
  if (n == null) return "text-meta";
  if (n >= 70) return "text-critical";
  if (n >= 40) return "text-attention";
  return "text-meta";
}

export function SeoBoard({ initial, onOpen }: { initial: SeoOpportunity[]; onOpen: (id: string) => void }): React.JSX.Element {
  const router = useRouter();
  const [cards, setCards] = useState<SeoOpportunity[]>(initial);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<SeoStage | null>(null);

  const byStage = (stage: SeoStage): SeoOpportunity[] => cards.filter((c) => c.stage === stage);

  async function persist(id: string, stage: SeoStage): Promise<void> {
    try {
      const r = await fetch(`/api/seo/opportunity/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "stage", stage }) });
      if (!r.ok) throw new Error("rejected");
    } catch {
      router.refresh(); // revert to server truth (e.g. an invalid transition the optimistic UI allowed)
    }
  }

  function moveTo(id: string, to: SeoStage): void {
    const card = cards.find((c) => c.id === id);
    if (!card || card.stage === to) return;
    if (!canTransition(card.stage, to)) return; // guard client-side too — no flicker on an illegal drop
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, stage: to } : c)));
    void persist(id, to);
  }

  return (
    <div className="h-[calc(100dvh-10rem)]">
      <div className="flex h-full items-start gap-3 overflow-auto p-1">
        {BOARD_STAGES.map((stage) => {
          const list = byStage(stage);
          const isOver = overCol === stage;
          const meta = STAGE_META[stage];
          const legal = dragId ? (() => { const c = cards.find((x) => x.id === dragId); return c ? canTransition(c.stage, stage) : true; })() : true;
          return (
            <div
              key={stage}
              onDragOver={(e) => { if (legal) { e.preventDefault(); setOverCol(stage); } }}
              onDragLeave={() => setOverCol((c) => (c === stage ? null : c))}
              onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain") || dragId; if (id) moveTo(id, stage); setOverCol(null); setDragId(null); }}
              className={`flex min-h-[120px] w-[220px] shrink-0 flex-col border border-border bg-panel transition-colors ${isOver && legal ? "border-foreground/30 bg-[var(--row-hover)]" : ""} ${dragId && !legal ? "opacity-50" : ""}`}
            >
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--row-rule)] bg-panel px-3 py-2.5">
                <span className={`text-[11.5px] font-medium uppercase tracking-[0.08em] ${meta.lane === "off" ? "text-meta" : "text-tertiary-text"}`}>{meta.label}</span>
                <span className="ml-auto text-[12px] tabular-nums text-meta">{list.length}</span>
              </div>
              <div className="space-y-1.5 p-1.5">
                {list.length === 0 && <p className="px-1 py-6 text-center text-[12px] text-meta">{isOver && legal ? "Drop here" : "—"}</p>}
                {list.map((c) => (
                  <div
                    key={c.id}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; setDragId(c.id); }}
                    onDragEnd={() => { setDragId(null); setOverCol(null); }}
                    onClick={() => onOpen(c.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") onOpen(c.id); }}
                    className={`group cursor-pointer border border-border bg-card p-2.5 transition-colors hover:border-foreground/25 ${dragId === c.id ? "opacity-40" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      {c.recommendedAction && <span className={`shrink-0 text-[10.5px] font-medium uppercase tracking-[0.06em] ${ACTION_TONE[c.recommendedAction] ?? "text-meta"}`}>{c.recommendedAction}</span>}
                      <span className={`ml-auto shrink-0 text-[12px] tabular-nums ${priorityTone(c.priority)}`}>{c.priority ?? "—"}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-[13px] font-medium text-foreground">{c.keyword}</div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <GripVertical className="size-3 shrink-0 cursor-grab text-meta/60" />
                      <span className="truncate text-[11.5px] text-meta">{c.category ?? "—"}{c.location && c.location !== "DMV" ? ` · ${c.location}` : ""}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
