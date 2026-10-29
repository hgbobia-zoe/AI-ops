"use client";

// Quote Pipeline — readable HORIZONTAL date-bucket bars (replaces the old annotated donut, whose leader
// lines crowded at small sizes). Two modes behind a toggle, BOTH range-independent (they show current
// state, so the dashboard date selector doesn't change them):
//
//   PIPELINE (default): "How much open business can we still win, and how soon?" Current OPEN quotes
//     (by EVENT date), split into event-date horizon buckets (0–7 / 8–14 / 15–30 / 31–60 / 60+ days).
//     Each bucket is one bar, weighted by $ value (or count when money is hidden), with the dollar AND
//     count labelled directly on the row, and the row links to the underlying records in Sales OS.
//
//   STAGES: "Where do we stand generally?" A current snapshot of active quotes by Goodshuffle stage —
//     New / Quote Sent / Action Needed / Signed (Lost excluded), as direct count bars.
//
// Every bar carries a text label (count and $), so meaning never depends on colour alone.

import { useState } from "react";
import Link from "next/link";
import { BarChart3, ArrowRight } from "lucide-react";

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
export interface StageData {
  // Current snapshot of active quotes by Goodshuffle stage (range-independent; Lost excluded).
  stageNew: number;
  stageQuoteSent: number;
  stageActionNeeded: number;
  stageSigned: number;
}

// Horizon urgency colours (vivid, matching the dashboard palette): nearer events are warmer.
const HORIZON_C = ["#f06a5e", "#f0953a", "#f0c13a", "#5e9cf7", "#8f74f2"];
// Goodshuffle's own stage colours: New = yellow, Quote Sent = blue, Action Needed = red, Signed = green.
const STAGE_C = ["#f0c13a", "#5e9cf7", "#f06a5e", "#3ad492"];

const moneyFull = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

interface Row {
  label: string;
  count: number;
  value: number | null;
  color: string;
  href: string;
}

export function QuotePipeline({ pipeline, stages, showMoney }: { pipeline: PipelineData; stages: StageData | null; showMoney: boolean }): React.JSX.Element {
  const [mode, setMode] = useState<"pipeline" | "stages">("pipeline");

  const pipeRows: Row[] = pipeline.buckets.map((b, i) => ({
    label: b.label,
    count: b.count,
    value: b.value,
    color: HORIZON_C[i % HORIZON_C.length],
    href: "/salesos",
  }));

  const stageRows: Row[] = stages
    ? [
        { label: "New", count: stages.stageNew, value: null, color: STAGE_C[0], href: "/salesos" },
        { label: "Quote Sent", count: stages.stageQuoteSent, value: null, color: STAGE_C[1], href: "/salesos" },
        { label: "Action Needed", count: stages.stageActionNeeded, value: null, color: STAGE_C[2], href: "/salesos" },
        { label: "Signed", count: stages.stageSigned, value: null, color: STAGE_C[3], href: "/salesos" },
      ]
    : [];
  const stageTotal = stages ? stages.stageNew + stages.stageQuoteSent + stages.stageActionNeeded + stages.stageSigned : 0;

  const rows = mode === "pipeline" ? pipeRows : stageRows;
  // Weight bars by $ value in pipeline+money mode, otherwise by count. Share the row's own metric.
  const weightByValue = mode === "pipeline" && showMoney && pipeRows.some((r) => r.value != null);
  const max = Math.max(1, ...rows.map((r) => (weightByValue ? r.value ?? 0 : r.count)));

  const isEmpty = mode === "pipeline" ? pipeline.count === 0 : stageTotal === 0;
  const subhead = mode === "pipeline" ? "Current open · by event date" : "Current · by Goodshuffle stage";

  return (
    <section className="surface flex h-full flex-col border p-3">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">
          <BarChart3 className="size-4 shrink-0 text-meta" /> Quote pipeline
        </h2>
        <div className="ml-auto flex gap-1.5">
          {(["pipeline", "stages"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
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

      <div className="mb-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.08em] text-meta">
        <span className="truncate">{subhead}</span>
        {mode === "pipeline" ? (
          <span className="shrink-0 tabular-nums text-tertiary-text">
            {pipeline.count} open{showMoney && pipeline.value != null ? ` · ${moneyFull(pipeline.value)}` : ""}
          </span>
        ) : (
          <span className="shrink-0 tabular-nums text-tertiary-text">{stageTotal} active</span>
        )}
      </div>

      {isEmpty ? (
        <p className="py-8 text-center text-[12px] text-meta">
          {mode === "pipeline" ? "No open quotes right now." : "No active quotes right now."}
        </p>
      ) : (
        <ul className="flex flex-1 flex-col justify-center gap-2.5" role="list">
          {rows.map((r) => {
            const metric = weightByValue ? r.value ?? 0 : r.count;
            const pct = Math.max(r.count > 0 ? 3 : 0, Math.round((metric / max) * 100));
            const right = showMoney && mode === "pipeline" ? moneyFull(r.value) : `${r.count}`;
            const rightSub = mode === "pipeline" ? `${r.count} quote${r.count === 1 ? "" : "s"}` : null;
            return (
              <li key={r.label}>
                <Link
                  href={r.href}
                  className="group flex items-center gap-2.5 rounded px-1 py-1 transition-colors hover:bg-[var(--row-hover)]"
                >
                  <span className="w-[62px] shrink-0 text-[11px] text-secondary-text">{r.label}</span>
                  <span className="relative h-[16px] min-w-0 flex-1 overflow-hidden rounded-[2px] bg-[var(--row-hover)]">
                    <span className="block h-full rounded-[2px]" style={{ width: `${pct}%`, background: r.color }} />
                  </span>
                  <span className="flex shrink-0 items-baseline gap-1.5 text-right">
                    <span className="text-[12.5px] font-semibold tabular-nums text-foreground">{right}</span>
                    {rightSub && <span className="w-[52px] text-left text-[10px] tabular-nums text-meta">{rightSub}</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <Link href="/salesos" className="mt-3 inline-flex items-center gap-0.5 self-start text-[11px] text-meta transition-colors hover:text-foreground">
        Open in Sales OS <ArrowRight className="size-3" />
      </Link>
    </section>
  );
}
