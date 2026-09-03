// Sales Intelligence (MVP5) — forward booking pipeline from the Goodshuffle bookings feed. Counts
// AND revenue are real (per upcoming week); near-term empty weeks are flagged.

import { TrendingUp, CalendarClock, DollarSign, AlertTriangle } from "lucide-react";
import { salesOverview } from "@/lib/sales/service";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

export default async function SalesPage(): Promise<React.JSX.Element> {
  const s = salesOverview(8);
  const gaps = s.pipeline.filter((b) => b.nearTermGap);
  const maxRev = s.pipeline.reduce((m, b) => Math.max(m, b.revenue ?? 0), 0);

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <TrendingUp className="size-7" /> Sales Intelligence
        </h1>
        <p className="text-sm text-muted-foreground">Booked events &amp; revenue across the next {s.horizonWeeks} weeks (from Goodshuffle bookings).</p>
      </header>

      {/* Scorecard */}
      <section className="mb-6 grid gap-3 md:grid-cols-3">
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><CalendarClock className="size-4" /> Booked events</div>
          <div className="text-3xl font-bold tabular-nums">{s.totalBooked}</div>
          <p className="mt-1 text-[11px] text-muted-foreground">Next {s.horizonWeeks} weeks.</p>
        </div>
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><DollarSign className="size-4" /> Revenue pipeline</div>
          <div className="text-3xl font-bold tabular-nums">{money(s.totalRevenue)}</div>
          <p className="mt-1 text-[11px] text-muted-foreground">Contract value booked in the horizon.</p>
        </div>
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">Weekly target</div>
          <div className="text-2xl font-bold tabular-nums">{s.weeklyRevenueTarget == null ? <span className="text-muted-foreground">Not set</span> : money(s.weeklyRevenueTarget)}</div>
          <p className="mt-1 text-[11px] text-muted-foreground">Goal per week — compare against the bars below.</p>
        </div>
      </section>

      {gaps.length > 0 && (
        <div className="mb-6 flex items-start gap-2.5 border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {gaps.length === 1 ? "A near-term week has" : `${gaps.length} near-term weeks have`} no booked events yet
            ({gaps.map((g) => g.label).join(", ")}). Worth confirming nothing is missing.
          </span>
        </div>
      )}

      {/* Pipeline by week — bars scaled by revenue, count + $ labelled */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Booking pipeline</h2>
        <div className="border border-white/10">
          {s.pipeline.map((b) => {
            const target = s.weeklyRevenueTarget;
            const pctWidth = maxRev > 0 && b.revenue != null ? Math.round((b.revenue / maxRev) * 100) : 0;
            const hitTarget = target != null && b.revenue != null && b.revenue >= target;
            return (
              <div key={b.weekStart} className="flex items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-b-0">
                <div className="w-24 shrink-0 text-sm text-muted-foreground">{b.label}</div>
                <div className="flex h-5 flex-1 items-center">
                  <div
                    className={`h-full ${b.nearTermGap ? "bg-amber-500/30" : hitTarget ? "bg-emerald-500/40" : "bg-white/20"}`}
                    style={{ width: `${b.revenue ? Math.max(pctWidth, 4) : 0}%` }}
                  />
                  {b.count === 0 && <span className="pl-1 text-xs text-muted-foreground">{b.nearTermGap ? "open" : "—"}</span>}
                </div>
                <div className="w-16 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{b.count} ev</div>
                <div className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums">{money(b.revenue)}</div>
              </div>
            );
          })}
        </div>
      </section>

      <p className="mt-6 text-[11px] text-muted-foreground">
        From Goodshuffle bookings (projects), counted by their logistics start date. Pull fresh data anytime from
        Settings → Pull Routes.
      </p>
    </main>
  );
}
