// Sales Trends — win/loss by SEASON, EVENT TYPE (inferred from the name), and AREA (DC/MD/VA).
// All from real outcomes. Event type is an inference from free text and is labelled as such.

import Link from "next/link";
import { ArrowLeft, CalendarRange, Tags, MapPin, Info } from "lucide-react";
import { salesTrends } from "@/lib/salesos/trendsService";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const pct = (r: number | null): string => (r == null ? "—" : `${Math.round(r * 100)}%`);

export default async function TrendsPage(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const t = salesTrends();

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <Link href="/salesos" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Sales OS
      </Link>

      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <CalendarRange className="size-7" /> Sales Trends
        </h1>
        <p className="text-sm text-muted-foreground">How you win and lose by season, event type, and area — from your own outcomes.</p>
      </header>

      {/* Seasonality */}
      <section className="mb-7">
        <h2 className="mb-2 text-lg font-semibold">By season</h2>
        <p className="mb-3 text-xs text-muted-foreground">Win rate and booked revenue by month, across all years.</p>
        <div className="border border-white/10">
          {t.season.map((s) => (
            <div key={s.month} className="flex items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-b-0">
              <div className="w-10 shrink-0 text-sm text-muted-foreground">{s.label}</div>
              <div className="flex h-5 flex-1 items-center gap-2">
                <div className="relative h-full flex-1 bg-white/5">
                  {s.winRate != null && <div className="absolute inset-y-0 left-0 bg-emerald-500/50" style={{ width: `${s.winRate * 100}%` }} />}
                </div>
                <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">{pct(s.winRate)}</span>
              </div>
              <div className="w-24 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {s.decided > 0 ? <><span className="text-emerald-300">{s.won}W</span> · <span className="text-amber-300">{s.lost}L</span></> : "no data"}
              </div>
              {showMoney && <div className="w-20 shrink-0 text-right text-xs tabular-nums text-emerald-200">{money(s.revenue)}</div>}
            </div>
          ))}
        </div>
      </section>

      {/* Event type (inferred) */}
      <section className="mb-7">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-lg font-semibold">By event type</h2>
          <span className="flex items-center gap-1 border border-white/10 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <Tags className="size-3" /> inferred from name
          </span>
        </div>
        <div className="border border-white/10">
          {t.types.map((ty) => (
            <div key={ty.type} className="flex items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-b-0">
              <div className="w-40 shrink-0 text-sm">{ty.label}</div>
              <div className="flex h-5 flex-1 items-center gap-2">
                <div className="relative h-full flex-1 bg-white/5">
                  {ty.winRate != null && <div className="absolute inset-y-0 left-0 bg-emerald-500/50" style={{ width: `${ty.winRate * 100}%` }} />}
                </div>
                <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">{pct(ty.winRate)}</span>
              </div>
              <div className="w-24 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {ty.decided > 0 ? <><span className="text-emerald-300">{ty.won}W</span> · <span className="text-amber-300">{ty.lost}L</span></> : "no data"}
              </div>
              {showMoney && <div className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{money(ty.avgWonValue)}<span className="text-[9px]"> avg</span></div>}
            </div>
          ))}
        </div>
      </section>

      {/* Area */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <MapPin className="size-4" />
          <h2 className="text-lg font-semibold">By area</h2>
        </div>
        {!t.hasLocationData ? (
          <div className="flex items-start gap-2 border border-white/10 bg-white/[0.03] p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            No location data yet — run a fresh Goodshuffle pull (it now captures venue + city/state) and this fills in per DC / MD / VA.
          </div>
        ) : (
          <div className="border border-white/10">
            {t.areas.map((a) => (
              <div key={a.region} className="flex items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-b-0">
                <div className="w-16 shrink-0 text-sm">{a.region}</div>
                <div className="flex h-5 flex-1 items-center gap-2">
                  <div className="relative h-full flex-1 bg-white/5">
                    {a.winRate != null && <div className="absolute inset-y-0 left-0 bg-emerald-500/50" style={{ width: `${a.winRate * 100}%` }} />}
                  </div>
                  <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">{pct(a.winRate)}</span>
                </div>
                <div className="w-24 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {a.decided > 0 ? <><span className="text-emerald-300">{a.won}W</span> · <span className="text-amber-300">{a.lost}L</span></> : "no data"}
                </div>
                {showMoney && <div className="w-20 shrink-0 text-right text-xs tabular-nums text-emerald-200">{money(a.revenue)}</div>}
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="mt-6 text-[11px] text-muted-foreground">
        Win/loss from real Goodshuffle outcomes (open quotes excluded from win rate). Event type is inferred from the event name — treat it as a
        best-guess grouping, not a Goodshuffle field.
      </p>
    </main>
  );
}
