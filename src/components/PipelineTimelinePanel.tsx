"use client";

// The Pipeline Status drawer body — one open quote's full, verbatim activity timeline (every stored
// touch across SMS, calls, email, quote milestones, notes, and the audit trail), plus the key facts.
// FACTS ONLY: a missing value renders "no record"; undated note lines keep their date exactly as the
// team wrote it and are shown separately (we never invent a year to place them on the timeline).

import { X, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import type { PipelineStatusRow } from "@/lib/salesos/execSummary";
import type { TimelineEntry } from "@/lib/salesos/timeline";

const money = (n: number | null): string => (n == null ? "no record" : "$" + Math.round(n).toLocaleString("en-US"));

const CHANNEL_LABEL: Record<TimelineEntry["channel"], string> = {
  sms: "Text",
  call: "Call",
  email: "Email",
  quote: "Quote",
  note: "Note",
  system: "Activity",
};

function dateTime(iso: string): string {
  const d = new Date(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function shortDate(ymd: string | null): string {
  if (!ymd) return "no record";
  const d = new Date(ymd.length > 10 ? ymd : `${ymd}T00:00:00`);
  return isNaN(d.getTime()) ? "no record" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function ago(iso: string | null): string {
  if (!iso) return "no record";
  const t = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return "no record";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-meta">{label}</div>
      <div className={`mt-0.5 text-[13.5px] ${tone ?? "text-foreground"}`}>{value}</div>
    </div>
  );
}

function DirIcon({ direction }: { direction: TimelineEntry["direction"] }): React.JSX.Element | null {
  if (direction === "in") return <ArrowDownLeft className="size-3.5 text-sky-300" aria-label="from client" />;
  if (direction === "out") return <ArrowUpRight className="size-3.5 text-emerald-300" aria-label="to client" />;
  return null;
}

export function PipelineTimelinePanel({ row, showMoney, onClose }: { row: PipelineStatusRow; showMoney: boolean; onClose: () => void }): React.JSX.Element {
  const dated = row.timeline.filter((e) => e.at != null);
  const undated = row.timeline.filter((e) => e.at == null);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="truncate text-[16px] font-medium text-foreground">{row.eventName || `Project ${row.id}`}</div>
          <div className="truncate text-[13px] text-muted-foreground">{row.clientName || "no client on record"}</div>
        </div>
        <button onClick={onClose} aria-label="Close" className="flex size-8 shrink-0 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      {/* Key facts */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5 border-b border-border px-5 py-4 sm:grid-cols-3">
        <Fact label="Stage" value={`${row.boardStatusLabel} · ${row.stateLabel}`} />
        {showMoney && <Fact label="Amount due" value={money(row.amountDue)} tone={row.amountDue ? "text-amber-200" : "text-meta"} />}
        {showMoney && <Fact label="Quote value" value={money(row.value)} />}
        <Fact label="Event" value={row.eventDate ? `${shortDate(row.eventDate)}${row.daysToEvent != null ? ` (${row.daysToEvent}d)` : ""}` : "no record"} />
        <Fact label="Quote sent" value={row.quoteSentAt ? dateTime(row.quoteSentAt) : shortDate(row.quoteSentDate)} />
        <Fact label="Quote opened" value={row.quoteOpenedAt ? dateTime(row.quoteOpenedAt) : "no record"} tone={row.quoteOpenedAt ? "text-foreground" : "text-meta"} />
        <Fact
          label="Last activity"
          value={row.lastActivity ? `${CHANNEL_LABEL[row.lastActivity.channel]} · ${ago(row.lastActivity.at)}` : "no record"}
          tone={row.awaitingReply ? "text-sky-300" : undefined}
        />
        <Fact
          label="Last rep outreach"
          value={row.lastOutbound ? `${CHANNEL_LABEL[row.lastOutbound.channel]} · ${ago(row.lastOutbound.at)}` : "no record"}
          tone={row.lastOutbound == null || row.neglected7 ? "text-critical" : undefined}
        />
        {row.openedNoFollowup && <Fact label="Flag" value="Opened, no follow-up" tone="text-amber-200" />}
      </div>

      {/* Timeline */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-meta">Activity ({dated.length})</div>
        {dated.length === 0 ? (
          <p className="py-6 text-[13px] text-muted-foreground">No dated activity on record.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {dated.map((e, i) => (
              <li key={i} className="flex gap-3 border-l border-[var(--row-rule)] pl-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <DirIcon direction={e.direction} />
                    <span className="text-[13px] font-medium text-foreground">{e.title}</span>
                  </div>
                  {e.detail && <div className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] text-tertiary-text">{e.detail}</div>}
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-meta">
                    <span>{dateTime(e.at as string)}</span>
                    <span aria-hidden>·</span>
                    <span>{CHANNEL_LABEL[e.channel]}</span>
                    <span aria-hidden>·</span>
                    <span className="uppercase tracking-[0.06em]">{e.source}</span>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}

        {undated.length > 0 && (
          <>
            <div className="mb-2 mt-6 text-[11px] font-medium uppercase tracking-[0.1em] text-meta">Logged notes (date as written)</div>
            <ul className="flex flex-col gap-2">
              {undated.map((e, i) => (
                <li key={i} className="border-l border-[var(--row-rule)] pl-3">
                  <div className="text-[12.5px] text-tertiary-text">{e.detail || e.title}</div>
                  {e.rawDate && <div className="mt-0.5 text-[11px] text-meta">noted {e.rawDate} · internal_notes</div>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
