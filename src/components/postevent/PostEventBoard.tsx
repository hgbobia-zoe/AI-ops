"use client";

// Post-Event Kanban. Columns are the workflow states; cards are eligible completed events. Dragging a
// card writes a STRUCTURED state transition (actor + timestamp) via /api/postevent/project/[id]/action,
// never just a visual change. Dropping onto Closed opens the closure dialog — a closure ALWAYS needs a
// structured reason ('Other' requires a note). Clicking a card opens its detail/timeline. Native HTML5
// drag-and-drop, no library (mirrors SalesBoard).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, GripVertical, AlertTriangle, LifeBuoy, X } from "lucide-react";
import {
  POSTEVENT_STATE_ORDER,
  POSTEVENT_STATE_LABEL,
  NEXT_ACTION_LABEL,
  DISPOSITION_LABEL,
  CLOSURE_GROUPS,
  CLOSURE_REASON_LABEL,
  type BoardColumns,
  type PostEventCard,
  type PostEventState,
  type ClosureReason,
} from "@/lib/postevent/types";

function fmtDate(ymd: string | null): string {
  if (!ymd) return "no date";
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
function ago(iso: string | null): string {
  if (!iso) return "no contact";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function ClosureDialog({ card, onClose, onConfirm }: { card: PostEventCard; onClose: () => void; onConfirm: (reason: ClosureReason, note: string) => void }): React.JSX.Element {
  const [reason, setReason] = useState<ClosureReason | "">("");
  const [note, setNote] = useState("");
  const needsNote = reason === "other";
  const canSave = reason !== "" && (!needsNote || note.trim().length > 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-[440px] rounded border border-border bg-panel p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[14px] font-medium text-foreground">Close: {card.customer}</h3>
          <button onClick={onClose} className="rounded p-1 text-meta hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <p className="mb-3 text-[12px] text-meta">A closure needs a structured reason. This is what makes the funnel measurable.</p>
        <div className="max-h-[46vh] space-y-3 overflow-y-auto">
          {CLOSURE_GROUPS.map((g) => (
            <div key={g.group}>
              <div className="mb-1 text-[10.5px] uppercase tracking-[0.08em] text-meta">{g.group}</div>
              <div className="space-y-1">
                {g.reasons.map((r) => (
                  <label key={r} className={`flex cursor-pointer items-center gap-2 rounded border px-2.5 py-1.5 text-[12.5px] transition-colors ${reason === r ? "border-foreground/40 bg-[var(--row-hover)] text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}>
                    <input type="radio" name="closure" className="accent-foreground" checked={reason === r} onChange={() => setReason(r)} />
                    {CLOSURE_REASON_LABEL[r]}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        {needsNote && (
          <textarea
            className="mt-3 w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            rows={2}
            placeholder="Required note for Other…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-[12.5px] text-meta hover:text-foreground">
            Cancel
          </button>
          <button
            disabled={!canSave}
            onClick={() => reason && onConfirm(reason, note)}
            className="rounded border border-foreground px-3 py-1.5 text-[12.5px] font-medium text-foreground disabled:opacity-40"
          >
            Close project
          </button>
        </div>
      </div>
    </div>
  );
}

export function PostEventBoard(): React.JSX.Element {
  const router = useRouter();
  const [cols, setCols] = useState<BoardColumns | null>(null);
  const [totals, setTotals] = useState<Record<PostEventState, number> | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<PostEventState | null>(null);
  const [closing, setClosing] = useState<PostEventCard | null>(null);

  async function load(): Promise<void> {
    const j = (await (await fetch("/api/postevent/board")).json()) as { columns: BoardColumns; totals: Record<PostEventState, number> };
    setCols(j.columns);
    setTotals(j.totals);
  }
  useEffect(() => {
    fetch("/api/postevent/board")
      .then((r) => r.json())
      .then((j: { columns: BoardColumns; totals: Record<PostEventState, number> }) => {
        setCols(j.columns);
        setTotals(j.totals);
      })
      .catch(() => {});
  }, []);

  function findCard(id: string): { card: PostEventCard; from: PostEventState } | null {
    if (!cols) return null;
    for (const s of POSTEVENT_STATE_ORDER) {
      const card = cols[s].find((c) => c.bookingId === id);
      if (card) return { card, from: s };
    }
    return null;
  }

  async function move(id: string, to: PostEventState): Promise<void> {
    const found = findCard(id);
    if (!found || found.from === to) return;
    if (to === "closed") {
      setClosing(found.card);
      return;
    }
    // optimistic
    setCols((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      next[found.from] = prev[found.from].filter((c) => c.bookingId !== id);
      next[to] = [{ ...found.card, state: to }, ...prev[to]];
      return next;
    });
    try {
      const r = await fetch(`/api/postevent/project/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "move", to }) });
      if (!r.ok) throw new Error("failed");
      await load();
    } catch {
      await load();
    }
  }

  async function confirmClose(reason: ClosureReason, note: string): Promise<void> {
    if (!closing) return;
    const id = closing.bookingId;
    setClosing(null);
    try {
      await fetch(`/api/postevent/project/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "close", reason, note }) });
    } finally {
      await load();
    }
  }

  if (!cols || !totals)
    return (
      <div className="flex items-center gap-2 p-6 text-[13px] text-meta">
        <Loader2 className="size-4 animate-spin" /> Loading board…
      </div>
    );

  return (
    <div className="h-[calc(100dvh-6rem)]">
      <div className="border-b border-border px-4 py-2 text-[12px] text-meta">
        <span className="text-tertiary-text">Post-Event</span> / Kanban — drag a card to advance it. Every move is recorded with who and when.
      </div>
      <div className="flex h-[calc(100%-2.4rem)] items-start gap-3 overflow-auto p-4">
        {POSTEVENT_STATE_ORDER.map((s) => {
          const list = cols[s];
          const isOver = overCol === s;
          return (
            <div
              key={s}
              onDragOver={(e) => {
                e.preventDefault();
                setOverCol(s);
              }}
              onDragLeave={() => setOverCol((c) => (c === s ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain") || dragId;
                if (id) void move(id, s);
                setOverCol(null);
                setDragId(null);
              }}
              className={`flex min-h-[140px] w-[236px] shrink-0 flex-col border border-border bg-panel transition-colors ${isOver ? "border-foreground/30 bg-[var(--row-hover)]" : ""}`}
            >
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--row-rule)] bg-panel px-3 py-2.5">
                <span className={`text-[11.5px] font-medium uppercase tracking-[0.08em] ${s === "closed" ? "text-muted-foreground" : "text-tertiary-text"}`}>{POSTEVENT_STATE_LABEL[s]}</span>
                <span className="ml-auto text-[12px] tabular-nums text-meta">{totals[s]}</span>
              </div>
              <div className="space-y-1.5 p-1.5">
                {list.length === 0 && <p className="px-1 py-6 text-center text-[12px] text-meta">{isOver ? "Drop here" : "Empty"}</p>}
                {list.map((c) => (
                  <div
                    key={c.bookingId}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", c.bookingId);
                      e.dataTransfer.effectAllowed = "move";
                      setDragId(c.bookingId);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverCol(null);
                    }}
                    onClick={() => router.push(`/postevent/project/${c.bookingId}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") router.push(`/postevent/project/${c.bookingId}`);
                    }}
                    className={`group cursor-pointer border border-border bg-card p-2.5 transition-colors hover:border-foreground/25 ${dragId === c.bookingId ? "opacity-40" : ""}`}
                  >
                    <div className="flex items-start gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">{c.customer}</span>
                      {c.openIssues > 0 && (
                        <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-critical/40 px-1 py-px text-[10px] text-critical" title={`${c.openIssues} open issue(s)`}>
                          <LifeBuoy className="size-2.5" />
                          {c.openIssues}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-meta">{c.eventName}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="rounded border border-border px-1.5 py-px text-[10.5px] text-tertiary-text">{fmtDate(c.eventDate)}</span>
                      {c.disposition && <span className="rounded border border-border px-1.5 py-px text-[10.5px] text-tertiary-text">{DISPOSITION_LABEL[c.disposition]}</span>}
                    </div>
                    {c.state !== "closed" && (
                      <div className="mt-1.5 flex items-center justify-between border-t border-[var(--row-rule)] pt-1.5">
                        <span className="inline-flex items-center gap-1 text-[11px] text-foreground">
                          <GripVertical className="size-3 text-meta/60" /> {NEXT_ACTION_LABEL[c.nextAction]}
                        </span>
                        <span className={`inline-flex items-center gap-1 text-[10.5px] tabular-nums ${c.stale ? "text-attention" : "text-meta"}`}>
                          {c.stale && <AlertTriangle className="size-2.5" />}
                          {c.daysInStage}d
                        </span>
                      </div>
                    )}
                    <div className="mt-1 text-[10.5px] text-meta">
                      {c.contactCount} contact{c.contactCount === 1 ? "" : "s"} · {ago(c.lastContactAt)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {closing && <ClosureDialog card={closing} onClose={() => setClosing(null)} onConfirm={confirmClose} />}
    </div>
  );
}
