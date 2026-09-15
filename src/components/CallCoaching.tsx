"use client";

// The per-call coaching detail — the teaching layer from the call recap (what the rep could tighten,
// the objections and how to handle them, the concerns the customer raised, what the rep committed to).
// Reused in two places: expanded inline under a call on the conversation timeline, and stacked in the
// lead panel's Coaching tab. Pure presentation of the EXISTING analysis; no new inference here.

import { GraduationCap, MessageSquareWarning, AlertCircle, CheckSquare, Gauge } from "lucide-react";
import type { CallCoachingItem, CallSignals, CallGauge } from "@/lib/coach/feedTypes";

const MOMENTUM_TONE: Record<string, string> = { good: "text-emerald-300", warn: "text-amber-300", bad: "text-rose-300", neutral: "text-muted-foreground" };
const DOT_TONE: Record<string, string> = { good: "bg-emerald-400", warn: "bg-amber-400", bad: "bg-rose-400", neutral: "bg-white/70" };

/** A slim slider gauge: a red→amber→green track with a marker at the computed position. Quick visual
 *  read of one metric (pace / talk balance / customer tone). */
function GaugeBar({ label, g }: { label: string; g: CallGauge }): React.JSX.Element {
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between text-[10.5px]">
        <span className="uppercase tracking-[0.08em] text-meta">{label}</span>
        <span className={MOMENTUM_TONE[g.tone]}>{g.label}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-gradient-to-r from-rose-500/30 via-amber-500/30 to-emerald-500/30">
        <div className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-black/50 ${DOT_TONE[g.tone]}`} style={{ left: `${Math.max(3, Math.min(97, g.pct))}%` }} />
      </div>
    </div>
  );
}

/** The instant, transcript-derived read (momentum, then slider gauges for pace / talk balance / tone,
 *  plus discovery-question count). Available before the AI recap is written. Computed facts, never invented. */
export function CallSignalsStrip({ s }: { s: CallSignals }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span className="flex items-center gap-1 font-medium"><Gauge className={`size-3.5 ${MOMENTUM_TONE[s.momentum.tone]}`} /> <span className={MOMENTUM_TONE[s.momentum.tone]}>Momentum {s.momentum.score}% · {s.momentum.label}</span></span>
        <span className="text-muted-foreground">{s.questions} discovery Q{s.questions === 1 ? "" : "s"}</span>
      </div>
      {(s.gauges.speed || s.gauges.balance || s.gauges.tone) && (
        <div className="space-y-1.5">
          {s.gauges.speed && <GaugeBar label="Talking speed" g={s.gauges.speed} />}
          {s.gauges.balance && <GaugeBar label="Talk balance" g={s.gauges.balance} />}
          {s.gauges.tone && <GaugeBar label="Customer tone" g={s.gauges.tone} />}
        </div>
      )}
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
