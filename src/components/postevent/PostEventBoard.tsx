"use client";

// Post-Event Kanban. Columns are the workflow states; cards are eligible completed events. Dragging a
// card writes a STRUCTURED state transition (actor + timestamp) via /api/postevent/project/[id]/action,
// never just a visual change. Dropping onto Closed opens the closure dialog — a closure ALWAYS needs a
// structured reason ('Other' requires a note). Clicking a card opens its detail/timeline. Native HTML5
// drag-and-drop, no library (mirrors SalesBoard).

import { useEffect, useMemo, useState } from "react";
import { Loader2, GripVertical, AlertTriangle, LifeBuoy, X, Phone, MessageSquare, Clock, Star, CalendarClock } from "lucide-react";
import { PostEventSidePanel } from "@/components/postevent/PostEventSidePanel";
import {
  POSTEVENT_STATE_ORDER,
  POSTEVENT_STATE_LABEL,
  NEXT_ACTION_LABEL,
  DISPOSITION_ORDER,
  DISPOSITION_LABEL,
  CONTACT_OUTCOME_LABEL,
  REVIEW_REQUEST_CHANNELS,
  REVIEW_REQUEST_CHANNEL_LABEL,
  CLOSURE_GROUPS,
  CLOSURE_REASON_LABEL,
  contactState,
  CONTACT_STATE_LABEL,
  isPositiveDisposition,
  type BoardColumns,
  type PostEventCard,
  type PostEventState,
  type ClosureReason,
  type Disposition,
  type ReviewRequestChannel,
  type PostEventConfig,
} from "@/lib/postevent/types";

function fmtDate(ymd: string | null): string {
  if (!ymd) return "—";
  // Accept both a plain ymd and a full ISO; take the date part.
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// The queue filters — a compact operational summary at the top of the board (real DB values only).
type QueueKey = "due" | "overdue" | "awaiting" | "issues" | "reviews";
const QUEUE_META: { key: QueueKey; label: string; icon: typeof Clock }[] = [
  { key: "due", label: "Due Today", icon: CalendarClock },
  { key: "overdue", label: "Overdue", icon: AlertTriangle },
  { key: "awaiting", label: "Awaiting Customer", icon: Clock },
  { key: "issues", label: "Open Issues", icon: LifeBuoy },
  { key: "reviews", label: "Review Requests", icon: Star },
];
function matchesQueue(c: PostEventCard, k: QueueKey): boolean {
  switch (k) {
    case "due":
      return c.dueToday;
    case "overdue":
      return c.overdue;
    case "awaiting":
      return c.nextAction === "await_response" && c.state !== "closed";
    case "issues":
      return c.openIssues > 0;
    case "reviews":
      return c.state === "review_requested";
  }
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
  const [cols, setCols] = useState<BoardColumns | null>(null);
  const [totals, setTotals] = useState<Record<PostEventState, number> | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<PostEventState | null>(null);
  const [closing, setClosing] = useState<PostEventCard | null>(null);
  // Gated transitions — a drag opens the dialog that collects the required data (never a bare move).
  const [confirming, setConfirming] = useState<PostEventCard | null>(null); // → Experience Confirmed (disposition)
  const [requesting, setRequesting] = useState<PostEventCard | null>(null); // → Review Requested (channel + destination)
  const [recording, setRecording] = useState<PostEventCard | null>(null); // → Review Completed (rating)
  const [drawerId, setDrawerId] = useState<string | null>(null); // card detail opens in the shared side panel
  const [filter, setFilter] = useState<QueueKey | null>(null); // My Queue quick-filter

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
    // Gated transitions open a dialog to collect the required data — a drag never writes dirty state.
    if (to === "closed") return setClosing(found.card);
    if (to === "experience_confirmed" && !found.card.disposition) return setConfirming(found.card);
    if (to === "review_requested") return setRequesting(found.card);
    if (to === "review_completed") return setRecording(found.card);
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

  async function confirmExperience(disposition: Disposition): Promise<void> {
    if (!confirming) return;
    const id = confirming.bookingId;
    setConfirming(null);
    try {
      // Record the experience (a human's read), then advance the state — the server requires the disposition.
      await fetch(`/api/postevent/project/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ disposition }) });
      await fetch(`/api/postevent/project/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "move", to: "experience_confirmed" }) });
    } finally {
      await load();
    }
  }

  async function confirmReviewRequest(channel: ReviewRequestChannel): Promise<void> {
    if (!requesting) return;
    const id = requesting.bookingId;
    setRequesting(null);
    try {
      await fetch(`/api/postevent/project/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "review_request", channel }) });
    } finally {
      await load();
    }
  }

  async function confirmReviewReceived(rating: number | null, link: string | null): Promise<void> {
    if (!recording) return;
    const id = recording.bookingId;
    setRecording(null);
    try {
      await fetch(`/api/postevent/project/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "review_received", rating, link }) });
    } finally {
      await load();
    }
  }

  const allCards = useMemo(() => (cols ? POSTEVENT_STATE_ORDER.flatMap((s) => cols[s]) : []), [cols]);
  const queueCounts = useMemo(() => {
    const c: Record<QueueKey, number> = { due: 0, overdue: 0, awaiting: 0, issues: 0, reviews: 0 };
    for (const card of allCards) for (const q of QUEUE_META) if (matchesQueue(card, q.key)) c[q.key]++;
    return c;
  }, [allCards]);

  if (!cols || !totals)
    return (
      <div className="flex items-center gap-2 p-6 text-[13px] text-meta">
        <Loader2 className="size-4 animate-spin" /> Loading board…
      </div>
    );

  return (
    <div className="flex h-[calc(100dvh-6rem)] flex-col">
      <div className="border-b border-border px-4 py-2 text-[12px] text-meta">
        <span className="text-tertiary-text">Post-Event</span> / Kanban — drag a card to advance it. Every move is recorded with who and when.
      </div>

      {/* My Queue — a compact operational summary; each is a clickable filter over the board. Real values. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="mr-1 text-[10.5px] font-medium uppercase tracking-[0.1em] text-meta">My Queue</span>
        {QUEUE_META.map((q) => {
          const Icon = q.icon;
          const on = filter === q.key;
          const n = queueCounts[q.key];
          const num = n === 0 ? "text-meta" : q.key === "overdue" ? "text-critical" : q.key === "due" ? "text-attention" : q.key === "issues" ? "text-critical" : "text-foreground";
          return (
            <button
              key={q.key}
              onClick={() => setFilter(on ? null : q.key)}
              aria-pressed={on}
              className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11.5px] transition-colors ${on ? "border-foreground/40 bg-[var(--row-hover)] text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}
            >
              <Icon className="size-3 text-meta" />
              {q.label}
              <span className={`tabular-nums ${num}`}>{n}</span>
            </button>
          );
        })}
        {filter && (
          <button onClick={() => setFilter(null)} className="text-[11px] text-meta transition-colors hover:text-foreground">
            Clear filter
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 items-start gap-3 overflow-auto p-4">
        {POSTEVENT_STATE_ORDER.map((s) => {
          const list = filter ? cols[s].filter((c) => matchesQueue(c, filter)) : cols[s];
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
              className={`flex min-h-[140px] w-[248px] shrink-0 flex-col border border-border bg-panel transition-colors ${isOver ? "border-foreground/30 bg-[var(--row-hover)]" : ""}`}
            >
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--row-rule)] bg-panel px-3 py-2.5">
                <span className={`text-[11.5px] font-medium uppercase tracking-[0.08em] ${s === "closed" ? "text-muted-foreground" : "text-tertiary-text"}`}>{POSTEVENT_STATE_LABEL[s]}</span>
                <span className="ml-auto text-[12px] tabular-nums text-meta">{filter ? list.length : totals[s]}</span>
              </div>
              <div className="space-y-1.5 p-1.5">
                {list.length === 0 && <p className="px-1 py-6 text-center text-[12px] text-meta">{isOver ? "Drop here" : filter ? "None" : "Empty"}</p>}
                {list.map((c) => (
                  <PostEventCardView
                    key={c.bookingId}
                    c={c}
                    dragging={dragId === c.bookingId}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", c.bookingId);
                      e.dataTransfer.effectAllowed = "move";
                      setDragId(c.bookingId);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverCol(null);
                    }}
                    onOpen={() => setDrawerId(c.bookingId)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {closing && <ClosureDialog card={closing} onClose={() => setClosing(null)} onConfirm={confirmClose} />}
      {confirming && <ExperienceDialog card={confirming} onClose={() => setConfirming(null)} onConfirm={confirmExperience} />}
      {requesting && <ReviewRequestDialog card={requesting} onClose={() => setRequesting(null)} onConfirm={confirmReviewRequest} />}
      {recording && <ReviewReceivedDialog card={recording} onClose={() => setRecording(null)} onConfirm={confirmReviewReceived} />}
      {drawerId && <PostEventSidePanel id={drawerId} onClose={() => setDrawerId(null)} onChanged={() => void load()} />}
    </div>
  );
}

// ── Gate dialogs (a drag into these columns must collect the required structured data) ────────────────
function DialogShell({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-[440px] rounded border border-border bg-panel p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-[14px] font-medium text-foreground">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-meta hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        {subtitle && <p className="mb-3 text-[12px] text-meta">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

function ExperienceDialog({ card, onClose, onConfirm }: { card: PostEventCard; onClose: () => void; onConfirm: (d: Disposition) => void }): React.JSX.Element {
  const [d, setD] = useState<Disposition | "">("");
  return (
    <DialogShell title={`Confirm experience: ${card.customer}`} subtitle="Record how the customer actually experienced the event. A human sets this; it is never inferred." onClose={onClose}>
      <div className="grid grid-cols-1 gap-1.5">
        {DISPOSITION_ORDER.map((opt) => (
          <label key={opt} className={`flex cursor-pointer items-center gap-2 rounded border px-2.5 py-1.5 text-[12.5px] transition-colors ${d === opt ? "border-foreground/40 bg-[var(--row-hover)] text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}>
            <input type="radio" name="exp" className="accent-foreground" checked={d === opt} onChange={() => setD(opt)} />
            {DISPOSITION_LABEL[opt]}
          </label>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-[12.5px] text-meta hover:text-foreground">
          Cancel
        </button>
        <button disabled={d === ""} onClick={() => d && onConfirm(d)} className="rounded border border-foreground px-3 py-1.5 text-[12.5px] font-medium text-foreground disabled:opacity-40">
          Confirm experience
        </button>
      </div>
    </DialogShell>
  );
}

function ReviewRequestDialog({ card, onClose, onConfirm }: { card: PostEventCard; onClose: () => void; onConfirm: (c: ReviewRequestChannel) => void }): React.JSX.Element {
  const [channel, setChannel] = useState<ReviewRequestChannel>("sms");
  const [cfg, setCfg] = useState<PostEventConfig | null>(null);
  useEffect(() => {
    fetch("/api/postevent/settings")
      .then((r) => r.json())
      .then((j: { config: PostEventConfig }) => setCfg(j.config))
      .catch(() => {});
  }, []);
  const dest = cfg ? cfg.reviewDestinationLabel || cfg.reviewDestinationUrl : "";
  const positive = isPositiveDisposition(card.disposition);
  return (
    <DialogShell title={`Request a review: ${card.customer}`} subtitle="Recorded as a funnel fact and the team is notified. The customer is not auto-messaged here; we never double-ask." onClose={onClose}>
      <div className="space-y-2 text-[12.5px]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-meta">Destination</span>
          {cfg == null ? (
            <span className="text-meta">Loading…</span>
          ) : dest ? (
            <span className="text-tertiary-text">{dest}</span>
          ) : (
            <span className="text-attention">Not set — configure in Settings</span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-meta">Channel</span>
          <select value={channel} onChange={(e) => setChannel(e.target.value as ReviewRequestChannel)} className="rounded border border-border bg-background px-2 py-1 text-[12.5px]">
            {REVIEW_REQUEST_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {REVIEW_REQUEST_CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        {!positive && <p className="rounded border border-attention/40 bg-attention/[0.05] px-2 py-1.5 text-[11.5px] text-attention">A review invitation is best after a confirmed positive experience.</p>}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-[12.5px] text-meta hover:text-foreground">
          Cancel
        </button>
        <button disabled={!dest} onClick={() => onConfirm(channel)} className="rounded border border-foreground px-3 py-1.5 text-[12.5px] font-medium text-foreground disabled:opacity-40" title={dest ? "" : "Set a review destination in Settings first"}>
          Request review
        </button>
      </div>
    </DialogShell>
  );
}

function ReviewReceivedDialog({ card, onClose, onConfirm }: { card: PostEventCard; onClose: () => void; onConfirm: (rating: number | null, link: string | null) => void }): React.JSX.Element {
  const [rating, setRating] = useState<number>(5);
  const [link, setLink] = useState("");
  return (
    <DialogShell title={`Review received: ${card.customer}`} subtitle="Record a review that actually came in. This is the terminal win." onClose={onClose}>
      <div className="space-y-2 text-[12.5px]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-meta">Rating</span>
          <select value={rating} onChange={(e) => setRating(Number(e.target.value))} className="rounded border border-border bg-background px-2 py-1 text-[12.5px]">
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n} of 5
              </option>
            ))}
          </select>
        </div>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Link (optional)" className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-[12.5px] text-meta hover:text-foreground">
          Cancel
        </button>
        <button onClick={() => onConfirm(rating, link.trim() || null)} className="rounded border border-foreground px-3 py-1.5 text-[12.5px] font-medium text-foreground">
          Mark received
        </button>
      </div>
    </DialogShell>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────────────────────────────
// Operational card: WHO / WHY / WHAT HAPPENED / WHAT'S NEXT. Contact reality is kept as three distinct
// facts (No contact recorded / attempted / responded), never collapsed to "0 contacts".
function PostEventCardView({
  c,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  c: PostEventCard;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}): React.JSX.Element {
  const cs = contactState(c.contactCount, c.respondedCount);
  const csColor = cs === "responded" ? "text-positive" : cs === "attempted" ? "text-tertiary-text" : "text-meta";
  const closed = c.state === "closed";
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className={`group cursor-pointer border border-border bg-card p-2.5 transition-colors hover:border-foreground/25 ${dragging ? "opacity-40" : ""}`}
    >
      {/* customer + open-issues */}
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">{c.customer}</span>
        {c.openIssues > 0 && (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-critical/40 px-1 py-px text-[10px] text-critical" title={`${c.openIssues} open issue(s)`}>
            <LifeBuoy className="size-2.5" />
            {c.openIssues}
          </span>
        )}
      </div>
      <div className="truncate text-[11.5px] text-meta">{c.venue || c.eventName}</div>
      <div className="mt-1 flex items-center gap-2 text-[10.5px] text-meta">
        <span>Event {fmtDate(c.eventDate)}</span>
        <span>·</span>
        <span>Pickup {fmtDate(c.pickupAt)}</span>
      </div>

      {/* NEXT ACTION + due (active) or closure reason (closed) */}
      {!closed ? (
        <div className="mt-1.5 border-t border-[var(--row-rule)] pt-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[9.5px] font-medium uppercase tracking-[0.1em] text-meta">Next Action</span>
            {c.dueToday ? (
              <span className="inline-flex items-center gap-0.5 rounded border border-attention/40 px-1 py-px text-[9.5px] text-attention">Due today</span>
            ) : c.overdue ? (
              <span className="inline-flex items-center gap-0.5 rounded border border-critical/40 px-1 py-px text-[9.5px] text-critical">
                <AlertTriangle className="size-2.5" /> Overdue
              </span>
            ) : c.dueAt ? (
              <span className="text-[9.5px] text-meta">Due {fmtDate(c.dueAt)}</span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[12.5px] font-medium text-foreground">
            {c.nextAction === "call" ? <Phone className="size-3 text-meta" /> : c.nextAction === "sms" ? <MessageSquare className="size-3 text-meta" /> : <GripVertical className="size-3 text-meta/60" />}
            {NEXT_ACTION_LABEL[c.nextAction]}
          </div>
          {c.stateReason && <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-meta">{c.stateReason}</div>}
        </div>
      ) : (
        c.stateReason && (
          <div className="mt-1.5 border-t border-[var(--row-rule)] pt-1.5 text-[10.5px] text-meta">
            Closed · {c.stateReason}
          </div>
        )
      )}

      {/* facts */}
      <div className="mt-1.5 space-y-0.5 border-t border-[var(--row-rule)] pt-1.5 text-[10.5px]">
        <Row k="Owner" v={<span className={c.assignedEmployee ? "text-tertiary-text" : "text-meta"}>{c.assignedEmployee || "Unassigned"}</span>} />
        <Row
          k="Last"
          v={
            c.lastContactAt ? (
              <span className="text-tertiary-text">
                {fmtDate(c.lastContactAt)}
                {c.lastContactOutcome ? ` · ${CONTACT_OUTCOME_LABEL[c.lastContactOutcome]}` : ""}
              </span>
            ) : (
              <span className="text-meta">No contact recorded</span>
            )
          }
        />
        <Row
          k="Attempts"
          v={
            <span className={csColor}>
              {c.contactCount}
              {cs !== "none" ? ` · ${CONTACT_STATE_LABEL[cs]}` : ""}
            </span>
          }
        />
        {c.disposition && <Row k="Experience" v={<span className="text-tertiary-text">{DISPOSITION_LABEL[c.disposition]}</span>} />}
        {!closed && (
          <Row
            k="In stage"
            v={
              <span className={`inline-flex items-center gap-1 tabular-nums ${c.stale ? "text-attention" : "text-meta"}`}>
                {c.stale && <AlertTriangle className="size-2.5" />}
                {c.daysInStage}d
              </span>
            }
          />
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-meta">{k}</span>
      <span className="min-w-0 truncate text-right">{v}</span>
    </div>
  );
}
