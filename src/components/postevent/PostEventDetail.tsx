"use client";

// Post-Event project detail — the whole journey reconstructed as one clean timeline (pickup, follow-up
// attempts, conversation, experience, issue/resolution, review request, review, closure) plus the human
// actions: set the experience disposition, log a contact attempt, request a review (idempotent, warm
// copy), mark a review received, open/advance a service-recovery issue, and close with a structured
// reason. Nothing is fabricated; every action is attributed. Types come from the pure module (no getDb).

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Loader2, ArrowLeft, Phone, Star, LifeBuoy, CheckCircle2, MessageSquare, Send } from "lucide-react";
import {
  POSTEVENT_STATE_LABEL,
  NEXT_ACTION_LABEL,
  DISPOSITION_ORDER,
  DISPOSITION_LABEL,
  CONTACT_CHANNEL_ORDER,
  CONTACT_CHANNEL_LABEL,
  CONTACT_OUTCOME_ORDER,
  CONTACT_OUTCOME_LABEL,
  REVIEW_REQUEST_CHANNELS,
  REVIEW_REQUEST_CHANNEL_LABEL,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  ISSUE_STATE_ORDER,
  ISSUE_STATE_LABEL,
  ESCALATION_LEVELS,
  ESCALATION_LEVEL_LABEL,
  CLOSURE_GROUPS,
  CLOSURE_REASON_LABEL,
  type PostEventProject,
  type ContactAttempt,
  type ReviewRecord,
  type IssueRecord,
  type PostEventConfig,
  type Disposition,
  type ContactChannel,
  type ContactOutcome,
  type ReviewRequestChannel,
  type IssueType,
  type IssueState,
  type EscalationLevel,
  type ClosureReason,
} from "@/lib/postevent/types";

interface Facts {
  bookingId: string;
  eventName: string;
  customer: string;
  venue: string | null;
  eventDate: string | null;
  status: string;
}
interface TimelineEntry {
  ts: string;
  kind: string;
  title: string;
  detail: string;
  actor: string | null;
}
interface Bundle {
  project: PostEventProject;
  facts: Facts;
  contacts: ContactAttempt[];
  reviews: ReviewRecord[];
  issues: IssueRecord[];
  timeline: TimelineEntry[];
  config: PostEventConfig;
}

const INPUT = "w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const BTN = "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50";
const CARD = "rounded border border-border p-3";

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className={CARD}>
      <h2 className="mb-2 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-tertiary-text">
        {icon} {title}
      </h2>
      {children}
    </section>
  );
}

export function PostEventDetail({ id }: { id: string }): React.JSX.Element {
  const [b, setB] = useState<Bundle | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/postevent/project/${id}`);
    if (!res.ok) {
      setErr(true);
      return;
    }
    setB((await res.json()) as Bundle);
  }, [id]);
  useEffect(() => {
    fetch(`/api/postevent/project/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not_found"))))
      .then((j: Bundle) => setB(j))
      .catch(() => setErr(true));
  }, [id]);

  async function patch(body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    try {
      await fetch(`/api/postevent/project/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function action(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/postevent/project/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) setMsg(String(j.message ?? j.error ?? "Action failed"));
      await load();
      return j;
    } finally {
      setBusy(false);
    }
  }

  if (err) return <main className="p-6 text-[13px] text-meta">Project not found.</main>;
  if (!b)
    return (
      <main className="flex items-center gap-2 p-6 text-[13px] text-meta">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </main>
    );

  const p = b.project;

  return (
    <main className="max-w-[900px] p-6">
      <Link href="/postevent/kanban" className="mb-3 inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Board
      </Link>
      <header className="mb-4">
        <h1 className="text-[20px] font-medium tracking-tight text-foreground">{b.facts.customer}</h1>
        <p className="text-[13px] text-meta">
          {b.facts.eventName}
          {b.facts.eventDate ? ` · ${b.facts.eventDate}` : ""}
          {b.facts.venue ? ` · ${b.facts.venue}` : ""}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="rounded border border-border px-2 py-0.5 text-foreground">{POSTEVENT_STATE_LABEL[p.state]}</span>
          <span className="rounded border border-border px-2 py-0.5 text-tertiary-text">Next: {NEXT_ACTION_LABEL[p.nextAction]}</span>
          {p.closureReason && <span className="rounded border border-border px-2 py-0.5 text-meta">Closed: {CLOSURE_REASON_LABEL[p.closureReason as ClosureReason] ?? p.closureReason}</span>}
        </div>
      </header>

      {msg && <div className="mb-3 rounded border border-attention/40 bg-attention/[0.05] px-3 py-2 text-[12.5px] text-attention">{msg}</div>}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* Experience disposition */}
        <Section title="Experience" icon={<CheckCircle2 className="size-3.5 text-meta" />}>
          <p className="mb-2 text-[11.5px] text-meta">Set once you understand how it went. A human sets this. AI could suggest it from a real transcript (Phase 2), never invent it.</p>
          <div className="flex flex-wrap gap-1.5">
            {DISPOSITION_ORDER.map((d) => (
              <button
                key={d}
                disabled={busy}
                onClick={() => patch({ disposition: p.disposition === d ? null : d })}
                className={`rounded border px-2 py-1 text-[12px] transition-colors ${p.disposition === d ? "border-foreground/40 bg-[var(--row-hover)] text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}
              >
                {DISPOSITION_LABEL[d as Disposition]}
              </button>
            ))}
          </div>
          {p.state === "customer_responded" && p.disposition && (
            <button disabled={busy} onClick={() => action({ type: "move", to: "experience_confirmed" })} className={`${BTN} mt-2 border-foreground text-foreground`}>
              Confirm experience
            </button>
          )}
        </Section>

        {/* Review */}
        <Section title="Review" icon={<Star className="size-3.5 text-meta" />}>
          <ReviewPanel bundle={b} busy={busy} onRequest={(channel, force) => action({ type: "review_request", channel, force })} onReceived={(rating, link) => action({ type: "review_received", rating, link })} />
        </Section>

        {/* Contacts */}
        <Section title="Contact attempts" icon={<Phone className="size-3.5 text-meta" />}>
          <ContactLogger busy={busy} onLog={(c) => action({ type: "contact", contact: c })} />
          <ul className="mt-2 space-y-1.5">
            {b.contacts.length === 0 && <li className="text-[12px] text-meta">No attempts yet. Some are auto-imported from Quo.</li>}
            {b.contacts.slice(0, 8).map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 border-t border-[var(--row-rule)] pt-1.5 text-[12px] first:border-t-0 first:pt-0">
                <span className="min-w-0 truncate text-tertiary-text">
                  {CONTACT_CHANNEL_LABEL[c.channel]} · {CONTACT_OUTCOME_LABEL[c.outcome]}
                  {c.source === "comms" && <span className="ml-1 text-meta">(auto)</span>}
                </span>
                <span className="shrink-0 tabular-nums text-meta">{fmtTs(c.occurredAt)}</span>
              </li>
            ))}
          </ul>
        </Section>

        {/* Issues / recovery */}
        <Section title="Issues / service recovery" icon={<LifeBuoy className="size-3.5 text-meta" />}>
          <IssuePanel bundle={b} busy={busy} onCreate={(i) => action({ type: "issue_create", issue: i })} onUpdate={(issueId, i) => action({ type: "issue_update", issueId, issue: i })} />
        </Section>
      </div>

      {/* Timeline */}
      <section className={`${CARD} mt-3`}>
        <h2 className="mb-2 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-tertiary-text">
          <MessageSquare className="size-3.5 text-meta" /> Timeline
        </h2>
        <ol className="space-y-2.5">
          {b.timeline.map((t, i) => (
            <li key={i} className="flex gap-3">
              <div className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-meta" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[13px] text-foreground">{t.title}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-meta">{fmtTs(t.ts)}</span>
                </div>
                {t.detail && <p className="text-[12px] text-meta">{t.detail}</p>}
                {t.actor && <p className="text-[11px] text-meta">{t.actor}</p>}
              </div>
            </li>
          ))}
          {b.timeline.length === 0 && <li className="text-[12px] text-meta">No activity yet.</li>}
        </ol>
      </section>

      {/* Close */}
      {p.state !== "closed" && (
        <div className="mt-3">
          <ClosePanel busy={busy} onClose={(reason, note) => action({ type: "close", reason, note })} />
        </div>
      )}
      {p.state === "closed" && (
        <button disabled={busy} onClick={() => action({ type: "reopen" })} className={`${BTN} mt-3`}>
          Reopen (customer responded after close)
        </button>
      )}
    </main>
  );
}

// ── Review panel ──────────────────────────────────────────────────────────────────────────────────
function ReviewPanel({ bundle, busy, onRequest, onReceived }: { bundle: Bundle; busy: boolean; onRequest: (channel: ReviewRequestChannel, force: boolean) => Promise<Record<string, unknown> | null>; onReceived: (rating: number | null, link: string | null) => void }): React.JSX.Element {
  const [channel, setChannel] = useState<ReviewRequestChannel>("sms");
  const [rating, setRating] = useState<number>(5);
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const requested = bundle.reviews.some((r) => r.kind === "requested");
  const received = bundle.reviews.some((r) => r.kind === "received");
  const positive = bundle.project.disposition === "positive" || bundle.project.disposition === "positive_minor";
  const dest = bundle.config.reviewDestinationLabel || bundle.config.reviewDestinationUrl;

  return (
    <div>
      {!positive && !requested && <p className="mb-2 text-[11.5px] text-meta">A review invitation is only appropriate after a confirmed positive experience.</p>}
      {!dest && <p className="mb-2 text-[11.5px] text-attention">No review destination configured yet. Set it in Post-Event settings so the link is not hard-coded.</p>}
      <div className="mb-2 rounded border border-[var(--row-rule)] bg-[var(--row-hover)]/40 p-2 text-[12px] text-tertiary-text">{bundle.config.reviewTemplate}</div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={INPUT + " w-auto"} value={channel} onChange={(e) => setChannel(e.target.value as ReviewRequestChannel)} disabled={busy}>
          {REVIEW_REQUEST_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {REVIEW_REQUEST_CHANNEL_LABEL[c]}
            </option>
          ))}
        </select>
        <button
          disabled={busy || (!positive && !requested)}
          onClick={async () => {
            const j = await onRequest(channel, requested);
            if (j && typeof j.message === "string") setPreview(j.message);
          }}
          className={`${BTN} border-foreground text-foreground`}
        >
          <Send className="size-3.5" /> {requested ? "Send again" : "Request review"}
        </button>
      </div>
      {requested && <p className="mt-1 text-[11.5px] text-positive">Review already requested. We never double-ask by default.</p>}
      {preview && <div className="mt-2 rounded border border-border p-2 text-[12px] text-meta">Composed message: {preview}</div>}

      {!received && (
        <div className="mt-3 border-t border-[var(--row-rule)] pt-2">
          <div className="mb-1 text-[11px] uppercase tracking-[0.06em] text-meta">Log a received review</div>
          <div className="flex flex-wrap items-center gap-2">
            <select className={INPUT + " w-auto"} value={rating} onChange={(e) => setRating(Number(e.target.value))}>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n} of 5
                </option>
              ))}
            </select>
            <input className={INPUT + " flex-1"} placeholder="Link (optional)" value={link} onChange={(e) => setLink(e.target.value)} />
            <button disabled={busy} onClick={() => onReceived(rating, link || null)} className={BTN}>
              Mark received
            </button>
          </div>
        </div>
      )}
      {received && <p className="mt-2 text-[12px] text-positive">Review received. This project is complete.</p>}
    </div>
  );
}

// ── Contact logger ──────────────────────────────────────────────────────────────────────────────────
function ContactLogger({ busy, onLog }: { busy: boolean; onLog: (c: { channel: ContactChannel; outcome: ContactOutcome; direction: string; notes: string }) => void }): React.JSX.Element {
  const [channel, setChannel] = useState<ContactChannel>("phone");
  const [outcome, setOutcome] = useState<ContactOutcome>("no_answer");
  const [notes, setNotes] = useState("");
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <select className={INPUT + " w-auto"} value={channel} onChange={(e) => setChannel(e.target.value as ContactChannel)}>
          {CONTACT_CHANNEL_ORDER.map((c) => (
            <option key={c} value={c}>
              {CONTACT_CHANNEL_LABEL[c]}
            </option>
          ))}
        </select>
        <select className={INPUT + " w-auto"} value={outcome} onChange={(e) => setOutcome(e.target.value as ContactOutcome)}>
          {CONTACT_OUTCOME_ORDER.map((o) => (
            <option key={o} value={o}>
              {CONTACT_OUTCOME_LABEL[o]}
            </option>
          ))}
        </select>
      </div>
      <input className={INPUT} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button
        disabled={busy}
        onClick={() => {
          onLog({ channel, outcome, direction: "outbound", notes });
          setNotes("");
        }}
        className={BTN}
      >
        Log attempt
      </button>
    </div>
  );
}

// ── Issue panel ───────────────────────────────────────────────────────────────────────────────────
function IssuePanel({ bundle, busy, onCreate, onUpdate }: { bundle: Bundle; busy: boolean; onCreate: (i: { issueType: IssueType; description: string }) => void; onUpdate: (issueId: string, i: Record<string, unknown>) => void }): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<IssueType>("damage");
  const [desc, setDesc] = useState("");
  return (
    <div>
      {bundle.issues.length === 0 && !adding && <p className="mb-2 text-[12px] text-meta">No issues. Open one if the customer reports a problem.</p>}
      <ul className="space-y-2">
        {bundle.issues.map((i) => (
          <li key={i.id} className="rounded border border-[var(--row-rule)] p-2">
            <div className="flex items-center justify-between gap-2 text-[12.5px]">
              <span className="text-foreground">{ISSUE_TYPE_LABEL[(i.issueType ?? "other") as IssueType]}</span>
              <select
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[11.5px]"
                value={i.state}
                disabled={busy}
                onChange={(e) => onUpdate(i.id, { state: e.target.value as IssueState })}
              >
                {ISSUE_STATE_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {ISSUE_STATE_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
            {i.description && <p className="mt-1 text-[12px] text-meta">{i.description}</p>}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <select
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-tertiary-text"
                value={i.escalationLevel}
                disabled={busy}
                onChange={(e) => onUpdate(i.id, { escalationLevel: e.target.value as EscalationLevel })}
              >
                {ESCALATION_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    Escalation: {ESCALATION_LEVEL_LABEL[l]}
                  </option>
                ))}
              </select>
            </div>
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="mt-2 space-y-2">
          <div className="flex gap-2">
            <select className={INPUT + " w-auto"} value={type} onChange={(e) => setType(e.target.value as IssueType)}>
              {ISSUE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ISSUE_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <input className={INPUT} placeholder="What happened?" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => {
                onCreate({ issueType: type, description: desc });
                setAdding(false);
                setDesc("");
              }}
              className={`${BTN} border-foreground text-foreground`}
            >
              Open issue
            </button>
            <button onClick={() => setAdding(false)} className={BTN}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className={`${BTN} mt-2`}>
          <LifeBuoy className="size-3.5" /> Open an issue
        </button>
      )}
    </div>
  );
}

// ── Close panel ───────────────────────────────────────────────────────────────────────────────────
function ClosePanel({ busy, onClose }: { busy: boolean; onClose: (reason: ClosureReason, note: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ClosureReason | "">("");
  const [note, setNote] = useState("");
  const needsNote = reason === "other";
  const canSave = reason !== "" && (!needsNote || note.trim().length > 0);
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className={BTN}>
        Close project…
      </button>
    );
  return (
    <div className={CARD}>
      <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Close with a structured reason</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {CLOSURE_GROUPS.map((g) => (
          <div key={g.group}>
            <div className="mb-1 text-[10.5px] uppercase tracking-[0.08em] text-meta">{g.group}</div>
            <div className="space-y-1">
              {g.reasons.map((r) => (
                <label key={r} className={`flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-[12px] transition-colors ${reason === r ? "border-foreground/40 bg-[var(--row-hover)] text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}>
                  <input type="radio" name="close2" className="accent-foreground" checked={reason === r} onChange={() => setReason(r)} />
                  {CLOSURE_REASON_LABEL[r]}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      {needsNote && <textarea className={INPUT + " mt-2"} rows={2} placeholder="Required note for Other…" value={note} onChange={(e) => setNote(e.target.value)} />}
      <div className="mt-2 flex gap-2">
        <button disabled={busy || !canSave} onClick={() => reason && onClose(reason, note)} className={`${BTN} border-foreground text-foreground`}>
          Close
        </button>
        <button onClick={() => setOpen(false)} className={BTN}>
          Cancel
        </button>
      </div>
    </div>
  );
}
