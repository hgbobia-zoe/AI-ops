"use client";

// Quote Pipeline — a donut with an accurate cohort (replaces the old broad "Quote Status" population).
// Two modes behind a compact toggle:
//
//   PIPELINE (default): "How much open business can we still win, and how soon?" Current OPEN quotes
//     (by EVENT date), the donut split into event-date horizon buckets (0–7 / 8–14 / 15–30 / 31–60 / 60+
//     days), colored by urgency (nearer = warmer). Center = open-quote count. Not restricted to the
//     global date range — it's the current open book.
//
//   ACTIVITY: "How are we converting the quotes we generate?" Quotes by CREATED/SENT date over the
//     selected global range, the donut split into signed / open / lost. Center = quotes created. Plus
//     a win rate. Pipeline (event date) and Activity (created date) never mix. Money gated by the caller.

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

interface Seg { label: string; value: number; color: string; display: string }

export function QuotePipeline({ pipeline, activity, showMoney }: { pipeline: PipelineData; activity: ActivityData | null; showMoney: boolean }): React.JSX.Element {
  const [mode, setMode] = useState<"pipeline" | "activity">("pipeline");

  // Pipeline donut: segment weight = $ value (or count when money is hidden); label shows the same.
  const pipeSegs: Seg[] = pipeline.buckets.map((b, i) => ({
    label: b.label,
    value: showMoney ? b.value ?? 0 : b.count,
    color: HORIZON_C[i],
    display: showMoney ? moneyFull(b.value) : String(b.count),
  }));

  const actSegs: Seg[] = activity
    ? [
        { label: "Signed", value: activity.signed, color: "#3ad492", display: String(activity.signed) },
        { label: "Open", value: activity.open, color: "#f0c13a", display: String(activity.open) },
        { label: "Lost", value: activity.lost, color: "#f06a5e", display: String(activity.lost) },
      ]
    : [];

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
          <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.08em] text-meta">
            <span>Current open · by event date</span>
            {showMoney && <span className="tabular-nums text-[var(--gold)]">{moneyFull(pipeline.value)}</span>}
          </div>
          {pipeline.count === 0 ? (
            <p className="py-6 text-center text-[12px] text-meta">No open quotes right now.</p>
          ) : (
            <Donut segments={pipeSegs} centerValue={String(pipeline.count)} centerLabel="open" showValue={showMoney} />
          )}
        </>
      ) : !activity || !showMoney ? (
        <p className="mt-2 text-[12.5px] text-meta">{showMoney ? "No quote activity in this period." : "Hidden for your role."}</p>
      ) : activity.created === 0 ? (
        <>
          <div className="mb-2 text-[10px] uppercase tracking-[0.08em] text-meta">Quote activity · {activity.label}</div>
          <p className="py-6 text-center text-[12px] text-meta">No quotes created {activity.label}.</p>
        </>
      ) : (
        <>
          <div className="mb-2 text-[10px] uppercase tracking-[0.08em] text-meta">Quote activity · {activity.label}</div>
          <Donut segments={actSegs} centerValue={String(activity.created)} centerLabel="created" showValue={false} />
          <div className="mt-3 flex items-center justify-between border-t border-rule pt-2.5">
            <span className="text-[11.5px] uppercase tracking-[0.08em] text-meta">Win rate</span>
            <span className="text-[15px] font-semibold tabular-nums text-foreground">{activity.winRate == null ? "—" : `${activity.winRate}%`}</span>
          </div>
        </>
      )}

      <Link href="/salesos" className="mt-3 inline-flex items-center gap-0.5 self-start text-[11px] text-meta transition-colors hover:text-foreground">
        Sales OS <ArrowRight className="size-3" />
      </Link>
    </section>
  );
}

// Thick donut + legend. `showValue` prints each segment's $ display; otherwise its count and share.
function Donut({ segments, centerValue, centerLabel, showValue }: { segments: Seg[]; centerValue: string; centerLabel: string; showValue: boolean }): React.JSX.Element {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = 49, cx = 60, cy = 60, C = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 120 120" width={112} height={112} className="shrink-0 -rotate-90">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--row-hover)" strokeWidth={22} />
        {total > 0 && segments.map((s) => {
          const len = (s.value / total) * C;
          const el = <circle key={s.label} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={22} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />;
          offset += len;
          return el;
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" className="rotate-90 fill-[var(--foreground)] text-[22px] font-semibold tabular-nums" transform="rotate(90 60 60)">{centerValue}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="fill-[var(--text-meta)] text-[8px] uppercase tracking-wide" transform="rotate(90 60 60)">{centerLabel}</text>
      </svg>
      <div className="min-w-0 flex-1 space-y-1.5">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-[11.5px]">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-secondary-text">{s.label}</span>
            <span className="shrink-0 tabular-nums text-foreground">{showValue ? s.display : s.value}</span>
            {!showValue && <span className="w-9 shrink-0 text-right tabular-nums text-meta">{total > 0 ? Math.round((s.value / total) * 100) : 0}%</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
