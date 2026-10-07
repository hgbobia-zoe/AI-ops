"use client";

// Quote Pipeline — replaces the old "Quote Status" cohort. Two modes behind a compact toggle:
//
//   PIPELINE (default): "How much open business can we still win?" Current OPEN quotes (by EVENT date),
//     split into event-date horizon buckets (0–7 / 8–14 / 15–30 / 31–60 / 60+ days). Not restricted to
//     the global date range — it's the current open book. Horizon colour = urgency (nearer = warmer),
//     because the real question for an event-rental business is how much open revenue is approaching.
//
//   ACTIVITY: "How are we converting the quotes we generate?" Quotes by CREATED/SENT date over the
//     selected global date range → created / signed / open / lost / win rate.
//
// Pipeline (event date) and Activity (created date) never mix. Money is gated by the caller.

import { useState } from "react";
import Link from "next/link";
import { PieChart, ArrowRight } from "lucide-react";

export interface PipelineBucket {
  label: string; // "0–7 days"
  count: number;
  value: number | null;
}
export interface PipelineData {
  count: number;
  value: number | null;
  buckets: PipelineBucket[];
}
export interface ActivityData {
  created: number;
  signed: number;
  open: number;
  lost: number;
  winRate: number | null; // signed / (signed + lost), or null when nothing is decided
  label: string; // "last 30 days"
}

// Horizon urgency colors (vivid, matching the dashboard palette): nearer events are warmer.
const HORIZON_C = ["#f06a5e", "#f0953a", "#f0c13a", "#5e9cf7", "#8f74f2"];

const moneyFull = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

export function QuotePipeline({ pipeline, activity, showMoney }: { pipeline: PipelineData; activity: ActivityData | null; showMoney: boolean }): React.JSX.Element {
  const [mode, setMode] = useState<"pipeline" | "activity">("pipeline");
  const maxBucket = Math.max(1, ...pipeline.buckets.map((b) => b.value ?? 0));

  return (
    <section className="surface flex flex-col border p-3">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">
          <PieChart className="size-4 text-meta" /> Quote pipeline
        </h2>
        <div className="ml-auto flex gap-1.5">
          {(["pipeline", "activity"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`h-[26px] rounded px-2.5 text-[11.5px] capitalize transition-colors ${
                mode === m
                  ? "border border-[var(--gold)] bg-[var(--gold)]/15 text-[var(--gold)]"
                  : "border border-[var(--bar)]/60 text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {mode === "pipeline" ? (
        <>
          <div className="text-[10px] uppercase tracking-[0.08em] text-meta">Current open · by event date</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-[24px] font-semibold tabular-nums leading-none">{pipeline.count}</span>
            <span className="text-[12px] text-meta">open quotes</span>
            {showMoney && <span className="ml-auto text-[15px] font-semibold tabular-nums text-[var(--gold)]">{moneyFull(pipeline.value)}</span>}
          </div>
          <div className="mt-3 space-y-1.5">
            {pipeline.buckets.map((b, i) => (
              <div key={b.label} className="flex items-center gap-2.5 text-[12px]">
                <span className="w-[62px] shrink-0 text-meta">{b.label}</span>
                <span className="h-[6px] flex-1 overflow-hidden rounded-[2px] bg-[var(--row-hover)]">
                  <span className="block h-full rounded-[2px]" style={{ width: `${Math.round(((b.value ?? 0) / maxBucket) * 100)}%`, background: HORIZON_C[i] }} />
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-secondary-text">{showMoney ? moneyFull(b.value) : b.count}</span>
              </div>
            ))}
          </div>
          {pipeline.count === 0 && <p className="mt-3 text-[12px] text-meta">No open quotes right now.</p>}
        </>
      ) : !activity || !showMoney ? (
        <p className="mt-2 text-[12.5px] text-meta">{showMoney ? "No quote activity in this period." : "Hidden for your role."}</p>
      ) : (
        <>
          <div className="text-[10px] uppercase tracking-[0.08em] text-meta">Quote activity · {activity.label}</div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2.5">
            <ActivityStat label="Created" value={activity.created} />
            <ActivityStat label="Signed" value={activity.signed} tone="good" />
            <ActivityStat label="Open" value={activity.open} tone="warn" />
            <ActivityStat label="Lost" value={activity.lost} tone="bad" />
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-rule pt-2.5">
            <span className="text-[11.5px] uppercase tracking-[0.08em] text-meta">Win rate</span>
            <span className="text-[15px] font-semibold tabular-nums text-foreground">{activity.winRate == null ? "—" : `${activity.winRate}%`}</span>
          </div>
          <p className="mt-2 text-[10.5px] text-meta">Of decided quotes created {activity.label}.</p>
        </>
      )}

      <Link href="/salesos" className="mt-3 inline-flex items-center gap-0.5 self-start text-[11px] text-meta transition-colors hover:text-foreground">
        Sales OS <ArrowRight className="size-3" />
      </Link>
    </section>
  );
}

function ActivityStat({ label, value, tone }: { label: string; value: number; tone?: "good" | "bad" | "warn" }): React.JSX.Element {
  const t = tone === "good" ? "text-positive" : tone === "bad" ? "text-critical" : tone === "warn" ? "text-attention" : "text-foreground";
  return (
    <div className="flex items-baseline gap-2">
      <span className={`text-[20px] font-semibold tabular-nums leading-none ${t}`}>{value}</span>
      <span className="text-[11.5px] text-meta">{label}</span>
    </div>
  );
}
