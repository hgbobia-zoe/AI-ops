"use client";

// Revenue Performance chart — a tabbed, grouped bar chart for the Command Center. Current year (gold) vs
// prior year (muted grey) per month, with the monthly target as a dashed reference line on the Revenue
// tab. One y-axis, thin marks with rounded data-ends, recessive grid, a legend for the two series, and a
// per-bar hover tooltip. Metrics: Revenue ($ signed), Quotes (count), Events (signed count). All values
// are real monthly data; a month with no data renders no bar (never a fabricated zero-as-value).

import { useState } from "react";

export interface MonthPoint {
  label: string; // "Jan"
  revenue: { cur: number | null; prev: number | null };
  quotes: { cur: number | null; prev: number | null };
  events: { cur: number | null; prev: number | null };
}

type Metric = "revenue" | "quotes" | "events";

export function RevenueTrendChart({
  months,
  target,
  curYear,
  prevYear,
  showMoney,
}: {
  months: MonthPoint[];
  target: number | null; // monthly revenue target (Revenue tab only)
  curYear: number;
  prevYear: number;
  showMoney: boolean;
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
  // "Nice" top for the axis (round up to 1 / 2 / 5 × 10^n).
  const niceMax = niceCeil(max);

  const W = 720;
  const H = 240;
  const padL = 44;
  const padR = 8;
  const padB = 22;
  const padT = 8;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const slot = plotW / months.length;
  const barW = Math.min(14, slot / 3.2);
  const gap = 3;

  const y = (v: number) => padT + plotH - (v / niceMax) * plotH;
  const fmt = (v: number | null): string => (v == null ? "—" : isMoney ? "$" + Math.round(v).toLocaleString("en-US") : String(Math.round(v)));
  const axisTick = (v: number): string => (isMoney ? "$" + compact(v) : String(v));

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));

  return (
    <div>
      {/* Tabs */}
      <div className="mb-3 flex items-center justify-between">
        <div className="inline-flex overflow-hidden rounded border border-border">
          {metrics.map((mt) => (
            <button
              key={mt.key}
              onClick={() => setMetric(mt.key)}
              className={`px-3 py-1 text-[12px] font-medium transition-colors ${metric === mt.key ? "bg-[var(--gold)]/15 text-[var(--gold)]" : "text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"}`}
            >
              {mt.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[10.5px] text-meta">
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-3 rounded-sm bg-[var(--gold)]" /> {curYear}</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-3 rounded-sm bg-[var(--bar)]" /> {prevYear}</span>
          {targetLine != null && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0 w-3 border-t border-dashed border-[var(--gold)]" /> Target</span>}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${metrics.find((x) => x.key === metric)!.label} by month, ${curYear} vs ${prevYear}`}>
        {/* Gridlines + y ticks */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--grid-rule)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" className="fill-[var(--text-meta)] text-[9px] tabular-nums">{axisTick(t)}</text>
          </g>
        ))}
        {/* Target line */}
        {targetLine != null && targetLine > 0 && targetLine <= niceMax && (
          <line x1={padL} x2={W - padR} y1={y(targetLine)} y2={y(targetLine)} stroke="var(--gold)" strokeWidth={1.25} strokeDasharray="4 3" />
        )}
        {/* Bars */}
        {months.map((m, i) => {
          const cx = padL + i * slot + slot / 2;
          const cur = pick(m).cur;
          const prev = pick(m).prev;
          const curX = cx - barW - gap / 2;
          const prevX = cx + gap / 2;
          return (
            <g key={m.label}>
              {prev != null && prev > 0 && (
                <rect x={prevX} y={y(prev)} width={barW} height={Math.max(2, padT + plotH - y(prev))} rx={2} fill="var(--bar)">
                  <title>{`${m.label} ${prevYear}: ${fmt(prev)}`}</title>
                </rect>
              )}
              {cur != null && cur > 0 && (
                <rect x={curX} y={y(cur)} width={barW} height={Math.max(2, padT + plotH - y(cur))} rx={2} fill="var(--gold)" fillOpacity={0.9}>
                  <title>{`${m.label} ${curYear}: ${fmt(cur)}`}</title>
                </rect>
              )}
              <text x={cx} y={H - 7} textAnchor="middle" className="fill-[var(--text-meta)] text-[9px]">{m.label[0]}</text>
            </g>
          );
        })}
      </svg>
    </div>
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
