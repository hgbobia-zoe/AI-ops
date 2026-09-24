"use client";

// Call detail — the Nocturne side panel over the queue. Header (caller, direction, time, duration,
// handled-by, status, sentiment, identity), the structured Call Reason with a human override, the
// conversation transcript with CUSTOMER: / SONA: / REP: speaker labels ("Transcript unavailable" when
// there is none — never fabricated), the AI summary, the actions we actually recorded, a handoff brief
// when escalated, and the full Context Pack. Reuses the app-wide SidePanelOverlay.

import { X, PhoneIncoming, PhoneOutgoing, MessageSquare, Clock, User, ArrowRightLeft } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { StatusMark, Provenance } from "@/components/console-primitives";
import { CALL_REASONS, REASON_LABEL } from "@/lib/comms/reasons";
import type { CallCard, TranscriptTurn } from "@/lib/comms/types";
import { ContextPackView } from "./ContextPackView";
import { fmtWhen, fmtDuration, fmtPhoneDisplay, IDENTITY_LABEL, IDENTITY_TONE, SENTIMENT_TONE } from "./helpers";

const SPEAKER_TONE: Record<TranscriptTurn["speaker"], string> = {
  CUSTOMER: "text-foreground",
  SONA: "text-[color:var(--positive)]",
  REP: "text-tertiary-text",
  UNKNOWN: "text-meta",
};
const SPEAKER_LABEL: Record<TranscriptTurn["speaker"], string> = { CUSTOMER: "CUSTOMER", SONA: "SONA", REP: "REP", UNKNOWN: "SPEAKER" };

export function CallDetailPanel({
  card,
  showMoney,
  onClose,
  onReasonChange,
  saving,
}: {
  card: CallCard;
  showMoney: boolean;
  onClose: () => void;
  onReasonChange: (reason: string | null) => void;
  saving: boolean;
}): React.JSX.Element {
  const r = card.row;
  const Dir = r.channel === "sms" ? MessageSquare : r.direction === "outgoing" ? PhoneOutgoing : PhoneIncoming;
  const idTone = IDENTITY_TONE[r.identityConfidence];
  const idToneText = idTone === "positive" ? "text-positive" : idTone === "attention" ? "text-attention" : "text-critical";

  return (
    <SidePanelOverlay onClose={onClose} widthClass="max-w-[46rem]">
      <div className="flex h-full flex-col bg-background @container">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Dir className="size-4 text-meta" />
              <h2 className="truncate text-[17px] font-medium text-foreground">{r.callerName}</h2>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-meta">
              <span>{r.channel === "sms" ? "SMS" : r.direction ?? "call"}</span>
              <span>· {fmtWhen(r.occurredAt ?? r.ts)}</span>
              {r.channel !== "sms" && <span className="inline-flex items-center gap-1"><Clock className="size-3" /> {fmtDuration(r.durationSec)}</span>}
              <span>· {fmtPhoneDisplay(r.callerPhone)}</span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="flex size-8 shrink-0 items-center justify-center rounded border border-border text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        {/* Status chips */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-2.5">
          <StatusMark tone={r.handledBy === "HUMAN" ? "positive" : r.handledBy === "TRANSFERRED" ? "attention" : "idle"} label={`Handled: ${r.handledBy === "AI" ? "AI" : r.handledBy === "HUMAN" ? "Human" : r.handledBy === "TRANSFERRED" ? "Transferred" : "Unknown"}`} />
          <StatusMark tone={r.status === "COMPLETED" ? "positive" : r.status === "MISSED" ? "critical" : "attention"} label={r.status[0] + r.status.slice(1).toLowerCase()} />
          <StatusMark tone={r.disposition === "ESCALATED" ? "critical" : "idle"} label={r.disposition === "ESCALATED" ? "Escalated" : "Disposition unknown"} />
          {r.sentiment && <span className={`text-[12px] capitalize ${SENTIMENT_TONE[r.sentiment] ?? "text-meta"}`}>Tone: {r.sentiment}</span>}
          <span className={`inline-flex items-center gap-1 text-[12px] ${idToneText}`}><User className="size-3" /> {IDENTITY_LABEL[r.identityConfidence]}</span>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* Call reason + override */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">Call reason</h3>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={r.reason}
                disabled={saving}
                onChange={(e) => onReasonChange(e.target.value)}
                className="rounded border border-border bg-[var(--row)] px-2 py-1.5 text-[13px] text-foreground outline-none focus:border-foreground/40 disabled:opacity-60"
              >
                {CALL_REASONS.map((rc) => (
                  <option key={rc} value={rc}>{REASON_LABEL[rc]}</option>
                ))}
              </select>
              {r.reasonMethod === "human" ? (
                <button onClick={() => onReasonChange(null)} disabled={saving} className="text-[11.5px] text-meta underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60">
                  reset to calculated
                </button>
              ) : (
                <Provenance kind="inferred" detail={`heuristic · ${Math.round(r.reasonConfidence * 100)}% confidence`} />
              )}
              {r.reasonMethod === "human" && <Provenance kind="verified" detail="human override" />}
            </div>
          </section>

          {/* Transcript */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">Conversation transcript</h3>
            {card.transcript && card.transcript.length ? (
              <div className="space-y-1.5 rounded border border-border bg-[var(--row)] p-3">
                {card.transcript.map((t, i) => (
                  <p key={i} className="text-[13px] leading-relaxed">
                    <span className={`mr-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] ${SPEAKER_TONE[t.speaker]}`}>{SPEAKER_LABEL[t.speaker]}:</span>
                    <span className="text-tertiary-text">{t.text}</span>
                  </p>
                ))}
              </div>
            ) : (
              <p className="rounded border border-border bg-[var(--row)] p-3 text-[12.5px] text-meta">Transcript unavailable.</p>
            )}
          </section>

          {/* AI summary */}
          <section>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">AI summary <Provenance kind="inferred" /></h3>
            <p className="text-[13px] leading-relaxed text-tertiary-text">{card.summary?.trim() || "Summary unavailable."}</p>
          </section>

          {/* Actions taken */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">Actions taken</h3>
            {card.actionsTaken.length ? (
              <ul className="space-y-1">
                {card.actionsTaken.map((a, i) => (
                  <li key={i} className="flex items-center justify-between rounded border border-border px-2.5 py-1.5 text-[12.5px]">
                    <span className="text-foreground">{a.label}{a.detail ? <span className="text-meta"> — {a.detail}</span> : null}</span>
                    <span className="shrink-0 text-[11px] text-meta">{fmtWhen(a.ts)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-meta">No system actions recorded for this call.</p>
            )}
          </section>

          {/* Handoff brief (when escalated) */}
          {card.handoff && (
            <section className="rounded border border-critical/40 bg-critical/[0.04] p-3">
              <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-critical"><ArrowRightLeft className="size-3.5" /> Human handoff brief</h3>
              <dl className="space-y-1 text-[12.5px]">
                <Row k="Customer" v={card.handoff.customer} />
                <Row k="Event" v={card.handoff.event ?? "Unavailable"} />
                <Row k="Reason" v={card.handoff.reasonLabel} />
                <Row k="Current state" v={card.handoff.currentState} />
                <Row k="Requested change" v={card.handoff.requestedChange ?? "Not stated"} />
                <Row k="Inventory" v={card.handoff.inventoryAvailability} />
                <Row k="Recommendation" v={card.handoff.aiRecommendation} inferred />
                <Row k="Summary" v={card.handoff.conversationSummary} />
              </dl>
            </section>
          )}

          {/* Context pack */}
          <section>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">Context pack</h3>
            <ContextPackView pack={card.context} showMoney={showMoney} />
          </section>

          <p className="pt-1 text-[11px] text-meta">
            Facts are computed from Zoe&apos;s systems (rules). The reason and summary are AI interpretation (inference) and never a system of record. Sona is not connected — no AI action was taken on this call.
          </p>
        </div>
      </div>
    </SidePanelOverlay>
  );
}

function Row({ k, v, inferred }: { k: string; v: string; inferred?: boolean }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-meta">{k}</dt>
      <dd className="min-w-0 flex-1 text-tertiary-text">{v}{inferred && <span className="ml-1.5 text-[10.5px] uppercase tracking-wide text-meta">(inference)</span>}</dd>
    </div>
  );
}
