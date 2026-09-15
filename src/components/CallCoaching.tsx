"use client";

// The per-call coaching detail — the teaching layer from the call recap (what the rep could tighten,
// the objections and how to handle them, the concerns the customer raised, what the rep committed to).
// Reused in two places: expanded inline under a call on the conversation timeline, and stacked in the
// lead panel's Coaching tab. Pure presentation of the EXISTING analysis; no new inference here.

import { GraduationCap, MessageSquareWarning, AlertCircle, CheckSquare, Gauge } from "lucide-react";
import type { CallCoachingItem, CallSignals } from "@/lib/coach/feedTypes";

const MOMENTUM_TONE: Record<string, string> = { good: "text-emerald-300", warn: "text-amber-300", bad: "text-rose-300", neutral: "text-muted-foreground" };

/** The instant, transcript-derived read (momentum, talk balance, pace, discovery questions). Available
 *  before the AI recap is written. All computed facts, never invented. */
export function CallSignalsStrip({ s }: { s: CallSignals }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
      <span className="flex items-center gap-1 font-medium"><Gauge className={`size-3.5 ${MOMENTUM_TONE[s.momentum.tone]}`} /> <span className={MOMENTUM_TONE[s.momentum.tone]}>Momentum {s.momentum.score}% · {s.momentum.label}</span></span>
      {s.repSharePct != null && <span className="text-muted-foreground">Talk balance <span className="text-foreground">{s.repSharePct}% you</span></span>}
      {s.wordsPerMin != null && <span className="text-muted-foreground">Pace <span className="text-foreground">{s.wordsPerMin} wpm</span></span>}
      <span className="text-muted-foreground">Discovery Qs <span className="text-foreground">{s.questions}</span></span>
    </div>
  );
}

export function CallCoaching({ data }: { data: CallCoachingItem }): React.JSX.Element {
  return (
    <div className="space-y-2.5 text-[13px]">
      {data.notes.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200"><GraduationCap className="size-3" /> Coaching</div>
          <ul className="list-disc space-y-0.5 pl-4">{data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      )}
      {data.objections.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-sky-200"><MessageSquareWarning className="size-3" /> Objections &amp; how to handle</div>
          <ul className="space-y-1.5">
            {data.objections.map((o, i) => (
              <li key={i}>
                <div className="text-foreground">{o.objection}</div>
                <div className="text-muted-foreground">{o.response}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.concerns.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><AlertCircle className="size-3" /> Customer concerns</div>
          <ul className="list-disc space-y-0.5 pl-4">{data.concerns.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      )}
      {data.actionItems.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-200"><CheckSquare className="size-3" /> You committed to</div>
          <ul className="list-disc space-y-0.5 pl-4">{data.actionItems.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
