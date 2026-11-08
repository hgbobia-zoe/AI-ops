// Opportunity Radar — analytics (§19). The funnel (discovered → qualified → target → outreach →
// contacted → in Sales OS → won) plus breakdowns by source, jurisdiction and type. All deterministic
// from stored state. The pipeline figure is an INDICATIVE range sum, never presented as booked revenue.

import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";
import { opportunityAnalytics, type Breakdown } from "@/lib/opportunity/analytics";
import { seedOpportunitiesIfEmpty, refreshOpportunities } from "@/lib/opportunity/seed";
import { seedRadarIfEmpty } from "@/lib/radar/seed";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

function fmtK(n: number): string {
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;
}

function BreakdownTable({ title, rows, money }: { title: string; rows: Breakdown[]; money: boolean }): React.JSX.Element {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <section className="mb-6">
      <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}</h2>
      <div className="overflow-x-auto border border-border">
        <table className={tableCls}>
          <colgroup><col /><col style={{ width: "90px" }} /><col style={{ width: "90px" }} /><col style={{ width: "110px" }} /></colgroup>
          <thead className={theadCls}><tr><th className={thCls}>Segment</th><th className={`${thCls} text-right`}>Total</th><th className={`${thCls} text-right`}>Qualified</th><th className={`${thCls} text-right`}>Stated value</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-[var(--row-rule)]">
                <td className="px-2.5 py-2">
                  <div className="text-foreground">{r.label}</div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded bg-[var(--bar)]"><div className="h-full bg-positive/60" style={{ width: `${Math.round((r.total / max) * 100)}%` }} /></div>
                </td>
                <td className="px-2.5 py-2 text-right tabular-nums">{r.total}</td>
                <td className="px-2.5 py-2 text-right tabular-nums text-tertiary-text">{r.qualified}</td>
                <td className="px-2.5 py-2 text-right tabular-nums text-meta">{!money ? "hidden" : r.valueHigh ? fmtK(r.valueHigh) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function AnalyticsPage(): Promise<React.JSX.Element> {
  try { await seedRadarIfEmpty(); } catch { /* ignore */ }
  try { await seedOpportunitiesIfEmpty(); } catch { /* ignore */ }
  try { await refreshOpportunities(); } catch { /* ignore */ }

  const a = opportunityAnalytics();
  const t = a.totals;
  const money = canSeeFinancials(await viewerRole());
  const figures: Figure[] = [
    { label: "Discovered", value: t.discovered },
    { label: "Qualified", value: t.qualified, tone: "positive" },
    { label: "With target", value: t.withTarget },
    { label: "Outreach drafted", value: t.outreachDrafted, sep: true },
    { label: "Contacted", value: t.contacted, tone: t.contacted ? "attention" : "default" },
    { label: "In Goodshuffle", value: t.inGoodshuffle },
    { label: "Signed", value: t.signedBookings, tone: t.signedBookings ? "positive" : "default" },
  ];
  const funnelMax = Math.max(1, ...a.funnel.map((f) => f.count));

  return (
    <main className="p-4 sm:p-6">
      <header className="mb-4"><h1 className="text-[22px] font-medium tracking-tight">Analytics</h1><p className="text-[12.5px] text-meta">From signal to signed revenue. Real records only; demo data is excluded.</p></header>

      <div className="mb-6"><FigureStrip figures={figures} /></div>

      {/* Funnel */}
      <section className="mb-6">
        <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Funnel <span className="text-[11px] normal-case text-meta">· signal → revenue</span></h2>
        <div className="border border-border p-3">
          {a.funnel.map((f) => (
            <div key={f.key} className="mb-1.5 flex items-center gap-3 last:mb-0">
              <span className="w-32 shrink-0 text-[12.5px] text-tertiary-text">{f.label}</span>
              <div className="h-4 flex-1 overflow-hidden rounded bg-[var(--bar)]"><div className="h-full bg-positive/70" style={{ width: `${Math.round((f.count / funnelMax) * 100)}%` }} /></div>
              <span className="w-8 shrink-0 text-right text-[12.5px] tabular-nums text-foreground">{f.count}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Revenue: three numbers kept apart on purpose. */}
      <section className="mb-6">
        <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Revenue <span className="text-[11px] normal-case text-meta">· estimate vs signed vs realized</span></h2>
        {!money ? (
          <p className="text-[12.5px] text-meta">Dollar figures are visible to owners and admins.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded border border-border p-3"><div className="text-[11px] uppercase tracking-[0.08em] text-meta">Stated value</div><div className="mt-1 text-[18px] tabular-nums text-tertiary-text">{t.withValueData ? fmtK(t.statedValueTotal) : "No value data"}</div><div className="text-[11px] text-meta">{t.withValueData} of {t.qualified} qualified have a value stated by the source; not revenue</div></div>
              <div className="rounded border border-border p-3"><div className="text-[11px] uppercase tracking-[0.08em] text-meta">Signed bookings</div><div className="mt-1 text-[18px] tabular-nums text-foreground">{fmtK(t.bookedRevenue)}</div><div className="text-[11px] text-meta">{t.signedBookings} signed Goodshuffle contracts from Radar</div></div>
              <div className="rounded border border-border p-3"><div className="text-[11px] uppercase tracking-[0.08em] text-meta">Realized</div><div className="mt-1 text-[18px] tabular-nums text-positive">{fmtK(t.realizedRevenue)}</div><div className="text-[11px] text-meta">signed and the event has happened</div></div>
            </div>
            {a.revenueBySource.length > 0 && (
              <div className="mt-3 overflow-x-auto border border-border">
                <table className={tableCls}>
                  <thead className={theadCls}><tr><th className={thCls}>Source</th><th className={`${thCls} text-right`}>Projects</th><th className={`${thCls} text-right`}>Signed</th><th className={`${thCls} text-right`}>Signed $</th><th className={`${thCls} text-right`}>Realized $</th></tr></thead>
                  <tbody>
                    {a.revenueBySource.map((r) => (
                      <tr key={r.key} className="border-t border-[var(--row-rule)]">
                        <td className="px-2.5 py-2 text-foreground">{r.label}</td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{r.projects}</td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{r.signed}</td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{fmtK(r.bookedRevenue)}</td>
                        <td className="px-2.5 py-2 text-right tabular-nums text-positive">{fmtK(r.realizedRevenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-[11.5px] text-meta">Signed and realized come from the linked Goodshuffle project&apos;s contract total. Each project counts once, under the first opportunity linked to it.</p>
          </>
        )}
      </section>

      <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
        <div><BreakdownTable title="By source" rows={a.bySource} money={money} /><BreakdownTable title="By type" rows={a.byKind} money={money} /></div>
        <div><BreakdownTable title="By jurisdiction" rows={a.byJurisdiction} money={money} /></div>
      </div>
    </main>
  );
}
