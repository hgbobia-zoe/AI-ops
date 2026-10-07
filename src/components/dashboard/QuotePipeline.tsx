"use client";

// Quote Pipeline — an annotated donut (leader lines call out each number) with an accurate cohort.
// Two modes behind a compact toggle:
//
//   PIPELINE (default): "How much open business can we still win, and how soon?" Current OPEN quotes
//     (by EVENT date), the donut split into event-date horizon buckets (0–7 / 8–14 / 15–30 / 31–60 / 60+
//     days), colored by urgency (nearer = warmer). Center = open-quote count. Not restricted to the
//     global date range — it's the current open book.
//
//   ACTIVITY: "How are we converting the quotes we generate?" Quotes by CREATED/SENT date over the
//     selected global range, split into signed / open / lost. Center = quotes created. Plus a win rate.
//     Pipeline (event date) and Activity (created date) never mix. Money gated by the caller.

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
const HORIZON_SHORT = ["0–7d", "8–14d", "15–30d", "31–60d", "60+d"];

const moneyFull = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

interface Seg { short: string; value: number; color: string; display: string }

export function QuotePipeline({ pipeline, activity, showMoney }: { pipeline: PipelineData; activity: ActivityData | null; showMoney: boolean }): React.JSX.Element {
  const [mode, setMode] = useState<"pipeline" | "activity">("pipeline");

  // Pipeline donut: slice weight = $ value (or count when money is hidden); callout shows the same.
  const pipeSegs: Seg[] = pipeline.buckets.map((b, i) => ({
    short: HORIZON_SHORT[i],
    value: showMoney ? b.value ?? 0 : b.count,
    color: HORIZON_C[i],
    display: showMoney ? moneyFull(b.value) : String(b.count),
  }));

  const actSegs: Seg[] = activity
    ? [
        { short: "Signed", value: activity.signed, color: "#3ad492", display: String(activity.signed) },
        { short: "Open", value: activity.open, color: "#f0c13a", display: String(activity.open) },
        { short: "Lost", value: activity.lost, color: "#f06a5e", display: String(activity.lost) },
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
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.08em] text-meta">
            <span>Current open · by event date</span>
            {showMoney && <span className="tabular-nums text-[var(--gold)]">{moneyFull(pipeline.value)}</span>}
          </div>
          {pipeline.count === 0 ? (
            <p className="py-8 text-center text-[12px] text-meta">No open quotes right now.</p>
          ) : (
            <AnnotatedDonut segments={pipeSegs} centerValue={String(pipeline.count)} centerLabel="open" />
          )}
        </>
      ) : !activity || !showMoney ? (
        <p className="mt-2 text-[12.5px] text-meta">{showMoney ? "No quote activity in this period." : "Hidden for your role."}</p>
      ) : activity.created === 0 ? (
        <>
          <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-meta">Quote activity · {activity.label}</div>
          <p className="py-8 text-center text-[12px] text-meta">No quotes created {activity.label}.</p>
        </>
      ) : (
        <>
          <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-meta">Quote activity · {activity.label}</div>
          <AnnotatedDonut segments={actSegs} centerValue={String(activity.created)} centerLabel="created" />
          <div className="mt-2 flex items-center justify-between border-t border-rule pt-2.5">
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

// ── Annotated donut ───────────────────────────────────────────────────────────
// Thick ring split into slices, each with a leader line out to its value + short label. Non-zero slices
// only; labels are collision-separated on each side. Drawn in normal orientation so arc + leader geometry
// share one coordinate frame.
const CX = 150, CY = 100, RO = 52, RI = 34, W = 300, H = 224, GAP = 32, LABEL_DX = 88;

function AnnotatedDonut({ segments, centerValue, centerLabel }: { segments: Seg[]; centerValue: string; centerLabel: string }): React.JSX.Element {
  const active = segments.filter((s) => s.value > 0);
  const total = active.reduce((s, x) => s + x.value, 0) || 1;

  // Slice + leader geometry (cumulative start via slice-reduce — no captured mutation).
  const geom = active.map((s, i, arr) => {
    const f = s.value / total;
    const start = arr.slice(0, i).reduce((cum, x) => cum + x.value / total, 0);
    const a0 = -Math.PI / 2 + start * 2 * Math.PI;
    const a1 = a0 + f * 2 * Math.PI;
    const mid = (a0 + a1) / 2;
    const side: "l" | "r" = Math.cos(mid) >= 0 ? "r" : "l";
    const [sx, sy] = pt(RO + 1, mid);
    const [ex, ey] = pt(RO + 10, mid);
    return { s, a0, a1, f, side, sx, sy, ex, ey };
  });

  // Separate labels vertically on each side so they don't overlap (functional, no mutation).
  const layoutSide = (side: "l" | "r") => {
    const arr = geom.filter((g) => g.side === side).sort((a, b) => a.ey - b.ey);
    const ys = arr.reduce<number[]>((acc, it, i) => [...acc, Math.max(it.ey, i === 0 ? -1e9 : acc[i - 1] + GAP)], []);
    const over = ys.length ? ys[ys.length - 1] - (H - 18) : 0;
    return arr.map((it, i) => ({ it, ly: Math.max(20, over > 0 ? ys[i] - over : ys[i]) }));
  };
  const laid = [...layoutSide("l"), ...layoutSide("r")];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Quote pipeline donut">
      {/* track */}
      <circle cx={CX} cy={CY} r={(RO + RI) / 2} fill="none" stroke="var(--row-hover)" strokeWidth={RO - RI} />
      {/* slices */}
      {geom.map((it, i) => (
        <path key={i} d={slicePath(it.a0, it.a1, it.f)} fill={it.s.color} />
      ))}
      {/* leaders + labels */}
      {laid.map(({ it, ly }, i) => {
        const labelX = it.side === "r" ? CX + LABEL_DX : CX - LABEL_DX;
        const tx = it.side === "r" ? labelX + 4 : labelX - 4;
        const anchor = it.side === "r" ? "start" : "end";
        return (
          <g key={`l${i}`}>
            <polyline points={`${it.sx.toFixed(1)},${it.sy.toFixed(1)} ${it.ex.toFixed(1)},${it.ey.toFixed(1)} ${labelX},${ly.toFixed(1)}`} fill="none" stroke="#6b7085" strokeWidth={1} />
            <circle cx={it.sx} cy={it.sy} r={2} fill={it.s.color} />
            <text x={tx} y={ly - 5} textAnchor={anchor} className="fill-[var(--foreground)] text-[12.5px] font-semibold tabular-nums">{it.s.display}</text>
            <text x={tx} y={ly + 6} textAnchor={anchor} className="fill-[var(--text-meta)] text-[9px] uppercase tracking-wide">{it.s.short}</text>
          </g>
        );
      })}
      {/* center */}
      <text x={CX} y={CY - 1} textAnchor="middle" className="fill-[var(--foreground)] text-[27px] font-semibold tabular-nums">{centerValue}</text>
      <text x={CX} y={CY + 16} textAnchor="middle" className="fill-[var(--text-meta)] text-[9px] uppercase tracking-wide">{centerLabel}</text>
    </svg>
  );
}

function pt(r: number, a: number): [number, number] { return [CX + r * Math.cos(a), CY + r * Math.sin(a)]; }

function slicePath(a0: number, a1: number, frac: number): string {
  // Full ring → split into two half-arcs to avoid a degenerate 360° path.
  if (frac >= 0.999) {
    const amid = a0 + Math.PI;
    return `${slicePath(a0, amid, 0.5)} ${slicePath(amid, a1, 0.5)}`;
  }
  const [ox0, oy0] = pt(RO, a0), [ox1, oy1] = pt(RO, a1);
  const [ix1, iy1] = pt(RI, a1), [ix0, iy0] = pt(RI, a0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${ox0.toFixed(2)} ${oy0.toFixed(2)} A${RO} ${RO} 0 ${large} 1 ${ox1.toFixed(2)} ${oy1.toFixed(2)} L${ix1.toFixed(2)} ${iy1.toFixed(2)} A${RI} ${RI} 0 ${large} 0 ${ix0.toFixed(2)} ${iy0.toFixed(2)} Z`;
}
