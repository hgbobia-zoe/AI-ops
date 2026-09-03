// Sales Intelligence (MVP5) — forward booking pipeline. Counts are REAL (booked events per
// upcoming week); the $ pipeline and forecast are DATA UNAVAILABLE until Goodshuffle revenue is
// captured. Nothing here fabricates money.

import { TrendingUp, CalendarClock, AlertTriangle } from "lucide-react";
import { salesOverview } from "@/lib/sales/service";

export const dynamic = "force-dynamic";

const money = (n: number): string => "$" + Math.round(n).toLocaleString("en-US");

function Unavail(): React.JSX.Element {
  return <span className="border border-white/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Data unavailable</span>;
}

export default async function SalesPage(): Promise<React.JSX.Element> {
  const s = salesOverview(8);
  const gaps = s.pipeline.filter((b) => b.nearTermGap);

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <TrendingUp className="size-7" /> Sales Intelligence
        </h1>
        <p className="text-sm text-muted-foreground">Booked events across the next {s.horizonWeeks} weeks. Revenue pipeline pending data capture.</p>
      </header>

      {/* Scorecard */}
      <section className="mb-6 grid gap-3 md:grid-cols-3">
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><CalendarClock className="size-4" /> Booked events</div>
          <div className="text-3xl font-bold tabular-nums">{s.totalBooked}</div>
          <p className="mt-1 text-[11px] text-muted-foreground">Next {s.horizonWeeks} weeks, counted once per event.</p>
        </div>
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><TrendingUp className="size-4" /> Revenue pipeline</div>
          <div className="text-2xl font-bold"><Unavail /></div>
          <p className="mt-1 text-[11px] text-muted-foreground">Needs Goodshuffle contract totals (capture pending).</p>
        </div>
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">Weekly target</div>
          <div className="text-2xl font-bold tabular-nums">{s.weeklyRevenueTarget == null ? <span className="text-muted-foreground">Not set</span> : money(s.weeklyRevenueTarget)}</div>
          <p className="mt-1 text-[11px] text-muted-foreground">Configured revenue goal — comparable once revenue is captured.</p>
        </div>
      </section>

      {gaps.length > 0 && (
        <div className="mb-6 flex items-start gap-2.5 border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {gaps.length === 1 ? "A near-term week has" : `${gaps.length} near-term weeks have`} no booked events yet
            ({gaps.map((g) => g.label).join(", ")}). Worth confirming nothing is missing from the board.
          </span>
        </div>
      )}

      {/* Pipeline by week */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Booking pipeline</h2>
        <div className="border border-white/10">
          {s.pipeline.map((b) => {
            const pctWidth = s.maxWeekCount > 0 ? Math.round((b.count / s.maxWeekCount) * 100) : 0;
            return (
              <div key={b.weekStart} className="flex items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-b-0">
                <div className="w-28 shrink-0 text-sm text-muted-foreground">{b.label}</div>
                <div className="flex h-5 flex-1 items-center">
                  <div
                    className={`h-full ${b.nearTermGap ? "bg-amber-500/30" : "bg-white/20"}`}
                    style={{ width: `${b.count === 0 ? 0 : Math.max(pctWidth, 6)}%` }}
                  />
                  {b.count === 0 && <span className="pl-1 text-xs text-muted-foreground">{b.nearTermGap ? "open" : "—"}</span>}
                </div>
                <div className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums">{b.count}</div>
              </div>
            );
          })}
        </div>
      </section>

      <p className="mt-6 text-[11px] text-muted-foreground">
        Counts come from booked stops on the dispatch board (one per event). Revenue pipeline, forecast vs target, and
        win/loss need Goodshuffle contract totals — a ~2-minute capture that&apos;s on the backlog. When it lands, the $
        columns fill in here automatically.
      </p>
    </main>
  );
}
