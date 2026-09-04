// Sales Intelligence (MVP5) — full-year revenue from the Goodshuffle bookings feed, navigable across
// years, broken down by month. SIGNED (committed contracts) vs ACTION-NEEDED (open quotes to win);
// lost/cancelled are excluded. The current year also shows the forward "next 8 weeks" pipeline.

import { TrendingUp, CalendarClock, DollarSign, AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { salesOverview, salesYearOverview } from "@/lib/sales/service";
import { todayInOpsTz } from "@/lib/dates";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const currentYear = Number(todayInOpsTz().slice(0, 4));
  const sp = await searchParams;
  const requested = Number.parseInt(sp.year ?? "", 10);
  const year = Number.isFinite(requested) && requested >= 2000 && requested <= currentYear ? requested : currentYear;

  const y = salesYearOverview(year);
  const maxMonthRev = y.months.reduce((m, b) => Math.max(m, b.revenue ?? 0), 0);

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <TrendingUp className="size-7" /> Sales Intelligence
        </h1>
        <p className="text-sm text-muted-foreground">
          Booked events{showMoney ? " & revenue" : ""} for {year} (from Goodshuffle bookings).
        </p>

        {/* Year navigator */}
        <div className="mt-3 flex items-center gap-2">
          {y.prevYear != null ? (
            <a href={`/sales?year=${y.prevYear}`} className="surface flex items-center gap-1 border border-white/10 px-2.5 py-1 text-sm hover:bg-white/5" aria-label={`Go to ${y.prevYear}`}>
              <ChevronLeft className="size-4" /> {y.prevYear}
            </a>
          ) : (
            <span className="flex items-center gap-1 border border-transparent px-2.5 py-1 text-sm text-muted-foreground/40"><ChevronLeft className="size-4" /></span>
          )}
          <span className="min-w-[5rem] text-center text-xl font-bold tabular-nums">{year}</span>
          {y.nextYear != null ? (
            <a href={`/sales?year=${y.nextYear}`} className="surface flex items-center gap-1 border border-white/10 px-2.5 py-1 text-sm hover:bg-white/5" aria-label={`Go to ${y.nextYear}`}>
              {y.nextYear} <ChevronRight className="size-4" />
            </a>
          ) : (
            <span className="flex items-center gap-1 border border-transparent px-2.5 py-1 text-sm text-muted-foreground/40"><ChevronRight className="size-4" /></span>
          )}
          {!y.isCurrentYear && (
            <a href="/sales" className="ml-1 text-xs text-muted-foreground underline hover:text-foreground">Back to {currentYear}</a>
          )}
        </div>
      </header>

      {/* Scorecard — full year */}
      <section className={`mb-6 grid gap-3 ${showMoney ? "md:grid-cols-3" : "md:grid-cols-1"}`}>
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><CalendarClock className="size-4" /> Events in {year}</div>
          <div className="text-3xl font-bold tabular-nums">
            {y.totalSignedCount}
            <span className="text-lg font-medium text-muted-foreground"> signed</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            <span className="text-amber-300">{y.totalActionNeededCount} action needed</span> · {y.totalBooked} live pipeline
          </p>
        </div>
        {showMoney && (
          <div className="surface border border-white/5 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><DollarSign className="size-4" /> {year} revenue</div>
            <div className="text-3xl font-bold tabular-nums text-emerald-300">{money(y.totalSignedRevenue)}<span className="text-lg font-medium text-muted-foreground"> signed</span></div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              <span className="text-amber-300">+ {money(y.totalActionNeededRevenue)} action needed</span> · {money(y.totalRevenue)} total pipeline
            </p>
          </div>
        )}
        {showMoney && (
          <div className="surface border border-white/5 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">Weekly target</div>
            <div className="text-2xl font-bold tabular-nums">{y.weeklyRevenueTarget == null ? <span className="text-muted-foreground">Not set</span> : money(y.weeklyRevenueTarget)}</div>
            <p className="mt-1 text-[11px] text-muted-foreground">Goal per week — {money((y.weeklyRevenueTarget ?? 0) * 52)}/yr at target.</p>
          </div>
        )}
      </section>

      {/* By month — the whole year */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{year} by month</h2>
        <div className="border border-white/10">
          {y.months.map((b) => {
            const denom = showMoney ? maxMonthRev : y.maxMonthCount;
            const total = showMoney ? b.revenue ?? 0 : b.count;
            const signed = showMoney ? b.signedRevenue ?? 0 : b.signedCount;
            const signedW = denom > 0 ? (signed / denom) * 100 : 0;
            const actionW = denom > 0 ? Math.max(0, (total - signed) / denom) * 100 : 0;
            return (
              <div key={b.month} className="flex items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-b-0">
                <div className="w-10 shrink-0 text-sm text-muted-foreground">{b.label}</div>
                <div className="flex h-5 flex-1 items-center">
                  <div className="h-full bg-emerald-500/60" style={{ width: `${signedW}%` }} title="signed" />
                  <div className="h-full bg-amber-500/50" style={{ width: `${actionW}%` }} title="action needed" />
                  {b.count === 0 && <span className="pl-1 text-xs text-muted-foreground/50">—</span>}
                </div>
                <div className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {b.signedCount > 0 && <span className="text-emerald-300">{b.signedCount} signed</span>}
                  {b.actionNeededCount > 0 ? <span className="text-amber-300">{b.signedCount > 0 ? " · " : ""}{b.actionNeededCount} to win</span> : ""}
                </div>
                {showMoney && (
                  <div className="w-24 shrink-0 text-right tabular-nums">
                    <div className="text-sm font-semibold text-emerald-300">{b.signedRevenue == null && b.count === 0 ? "—" : money(b.signedRevenue)}</div>
                    {b.revenue != null && b.revenue !== (b.signedRevenue ?? 0) && <div className="text-[10px] text-muted-foreground">{money(b.revenue)} total</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 px-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 bg-emerald-500/60" /> Signed (committed)</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 bg-amber-500/50" /> Action needed (open quote to win)</span>
        </div>
      </section>

      {/* Forward operational pipeline — only meaningful for the current year */}
      {y.isCurrentYear && <ForwardPipeline showMoney={showMoney} />}

      <p className="mt-6 text-[11px] text-muted-foreground">
        From Goodshuffle bookings (projects), counted by their logistics start date. Lost/cancelled quotes are
        excluded. Pull fresh data anytime from Settings → Pull Routes.
      </p>
    </main>
  );
}

/** The original forward 8-week pipeline — surfaced under the yearly view for the current year, since a
 *  "next 8 weeks" horizon only makes sense from today. */
function ForwardPipeline({ showMoney }: { showMoney: boolean }): React.JSX.Element {
  const s = salesOverview(8);
  const gaps = s.pipeline.filter((b) => b.nearTermGap);
  const maxRev = s.pipeline.reduce((m, b) => Math.max(m, b.revenue ?? 0), 0);

  return (
    <section className="mt-8 space-y-2">
      <h2 className="text-lg font-semibold">Coming up — next {s.horizonWeeks} weeks</h2>

      {gaps.length > 0 && (
        <div className="mb-2 flex items-start gap-2.5 border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {gaps.length === 1 ? "A near-term week has" : `${gaps.length} near-term weeks have`} no booked events yet
            ({gaps.map((g) => g.label).join(", ")}). Worth confirming nothing is missing.
          </span>
        </div>
      )}

      <div className="border border-white/10">
        {s.pipeline.map((b) => {
          const denom = showMoney ? maxRev : s.maxWeekCount;
          const total = showMoney ? b.revenue ?? 0 : b.count;
          const signed = showMoney ? b.signedRevenue ?? 0 : b.signedCount;
          const signedW = denom > 0 ? (signed / denom) * 100 : 0;
          const actionW = denom > 0 ? Math.max(0, (total - signed) / denom) * 100 : 0;
          const action = b.actionNeededCount;
          return (
            <div key={b.weekStart} className="flex items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-b-0">
              <div className="w-24 shrink-0 text-sm text-muted-foreground">{b.label}</div>
              <div className="flex h-5 flex-1 items-center">
                <div className="h-full bg-emerald-500/60" style={{ width: `${signedW}%` }} title="signed" />
                <div className="h-full bg-amber-500/50" style={{ width: `${actionW}%` }} title="action needed" />
                {b.count === 0 && <span className="pl-1 text-xs text-muted-foreground">{b.nearTermGap ? "open" : "—"}</span>}
              </div>
              <div className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                <span className="text-emerald-300">{b.signedCount} signed</span>
                {action > 0 ? <span className="text-amber-300"> · {action} to win</span> : ""}
              </div>
              {showMoney && (
                <div className="w-24 shrink-0 text-right tabular-nums">
                  <div className="text-sm font-semibold text-emerald-300">{money(b.signedRevenue)}</div>
                  {b.revenue != null && b.revenue !== (b.signedRevenue ?? 0) && <div className="text-[10px] text-muted-foreground">{money(b.revenue)} total</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
