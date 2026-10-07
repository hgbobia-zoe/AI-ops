"use client";

// Revenue Performance card (Command Center v3) — matches the design-handoff mockup exactly: a left $-axis
// column, a horizontal-gridline plot, grouped per-month bars (current year gold, current month a lighter
// gold, prior year a dark slate), full month labels, tabs in the header, and a bottom-centered legend.
// Current year (gold) vs prior year per month, with the monthly target as a dashed reference line on the
// Revenue tab. Metrics: Revenue ($ signed), Quotes (count), Events (signed count). All values are real
// monthly data; a month with no data renders no bar (never a fabricated zero-as-value).

import { useState } from "react";
import { TrendingUp } from "lucide-react";

export interface MonthPoint {
  label: string; // "Jan"
  revenue: { cur: number | null; prev: number | null };
  quotes: { cur: number | null; prev: number | null };
  events: { cur: number | null; prev: number | null };
}

type Metric = "revenue" | "quotes" | "events";

// Mockup chart palette (exact handoff hexes).
const GOLD = "#d4b36b";
const GOLD_LIGHT = "#e6cb8f"; // current month highlight
const PREV = "#33364a"; // prior-year bars

export function RevenueTrendChart({
  months,
  target,
  curYear,
  prevYear,
  showMoney,
  currentMonthIdx,
}: {
  months: MonthPoint[];
  target: number | null; // monthly revenue target (Revenue tab only)
  curYear: number;
  prevYear: number;
  showMoney: boolean;
  currentMonthIdx: number; // 0-11, highlighted lighter-gold bar
}): React.JSX.Element {
  const metrics: { key: Metric; label: string }[] = [
    ...(showMoney ? [{ key: "revenue" as Metric, label: "Revenue" }] : []),
    { key: "quotes", label: "Quotes" },
    { key: "events", label: "Events" },
  ];
  const [metric, setMetric] = useState<Metric>(metrics[0].key);

  const pick = (m: MonthPoint) => m[metric];
  const isMoney = metric === "revenue";
  const targetLine = isMoney ? target : null;

  const max = Math.max(
    months.reduce((mx, m) => Math.max(mx, pick(m).cur ?? 0, pick(m).prev ?? 0), 0),
    targetLine ?? 0,
    1,
  );
  // Clean axis: 4 even steps, each a "nice" round number (so labels are $20K/$40K/… not $12.5K).
  const step = niceCeil(max / 4);
  const niceMax = step * 4;

  // Y-axis labels top → bottom (5 ticks), formatted for the active metric.
  const ticks = [4, 3, 2, 1, 0].map((i) => step * i);
  const axisTick = (v: number): string => (isMoney ? "$" + compact(v) : String(v));
  const fmt = (v: number | null): string => (v == null ? "—" : isMoney ? "$" + Math.round(v).toLocaleString("en-US") : String(Math.round(v)));

  // Target line position as a % from the top of the plot (horizontal — the honest reading of a flat
  // monthly target), styled like the mockup's dashed reference line.
  const targetPct = targetLine != null && targetLine > 0 && targetLine <= niceMax ? (1 - targetLine / niceMax) * 100 : null;

  return (
    <section className="surface flex flex-col border p-3 px-3.5">
      {/* Header: title + tabs (mockup puts the metric tabs in the header row) */}
      <div className="mb-2 flex items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-[12.5px] font-medium uppercase tracking-[0.06em] text-tertiary-text">
          <TrendingUp className="size-[15px] text-meta" /> Revenue performance
        </h2>
        <div className="ml-auto flex gap-1.5">
          {metrics.map((mt) => (
            <button
              key={mt.key}
              onClick={() => setMetric(mt.key)}
              className={`h-[26px] rounded px-3 text-[12px] transition-colors ${
                metric === mt.key
                  ? "border border-[var(--gold)] bg-[var(--gold)]/15 text-[var(--gold)]"
                  : "border border-[var(--bar)]/60 text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"
              }`}
            >
              {mt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Plot: 38px axis column + chart */}
      <div className="grid" style={{ gridTemplateColumns: "38px minmax(0,1fr)" }}>
        <div className="-mt-1.5 flex h-[120px] flex-col justify-between pr-2 text-right text-[10.5px] tabular-nums text-meta">
          {ticks.map((t, i) => <span key={i}>{axisTick(t)}</span>)}
        </div>
        <div>
          <div
            className="relative h-[120px] border-b border-[#2c2f3a]"
            style={{ backgroundImage: "repeating-linear-gradient(to bottom,#22242f 0 1px,transparent 1px 30px)" }}
          >
            <div className="absolute inset-0 grid grid-cols-12 items-end px-1">
              {months.map((m, i) => {
                const cur = pick(m).cur;
                const prev = pick(m).prev;
                const curH = cur != null && cur > 0 ? (cur / niceMax) * 100 : null;
                const prevH = prev != null && prev > 0 ? (prev / niceMax) * 100 : null;
                return (
                  <div
                    key={m.label}
                    className="flex h-full items-end justify-center gap-[2px]"
                    title={`${m.label} · ${curYear} ${fmt(cur)} · ${prevYear} ${fmt(prev)}`}
                  >
                    <span
                      className="w-[9px] rounded-t-[1px]"
                      style={{ height: curH != null ? `${curH}%` : 0, background: i === currentMonthIdx ? GOLD_LIGHT : GOLD }}
                    />
                    <span className="w-[9px] rounded-t-[1px]" style={{ height: prevH != null ? `${prevH}%` : 0, background: PREV }} />
                  </div>
                );
              })}
            </div>
            {targetPct != null && (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full">
                <line x1="0" y1={targetPct} x2="100" y2={targetPct} stroke="#b2b6ca" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
              </svg>
            )}
          </div>
          <div className="grid grid-cols-12 px-1 pt-1.5 text-center text-[10.5px] text-meta">
            {months.map((m) => <span key={m.label}>{m.label}</span>)}
          </div>
        </div>
      </div>

      {/* Legend (bottom, centered) */}
      <div className="mt-1 flex justify-center gap-[22px] text-[11.5px] text-tertiary-text">
        <span className="flex items-center gap-1.5"><span className="size-[9px] rounded-[1px]" style={{ background: GOLD }} /> {curYear} {isMoney ? "Revenue" : ""}</span>
        {targetPct != null && <span className="flex items-center gap-1.5"><span className="inline-block w-3.5 border-t border-dashed border-[#b2b6ca]" /> Target</span>}
        <span className="flex items-center gap-1.5"><span className="size-[9px] rounded-[1px]" style={{ background: PREV }} /> {prevYear} {isMoney ? "Revenue" : ""}</span>
      </div>
    </section>
  );
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const n = v / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * base;
}

function compact(v: number): string {
  if (v >= 1000) return (Math.round(v / 100) / 10).toLocaleString("en-US") + "K";
  return String(v);
}
