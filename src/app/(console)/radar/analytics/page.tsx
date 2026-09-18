// Opportunity Radar — analytics (§19). The funnel (discovered → qualified → target → outreach →
// contacted → in Sales OS → won) plus breakdowns by source, jurisdiction and type. All deterministic
// from stored state. The pipeline figure is an INDICATIVE range sum, never presented as booked revenue.

import { RadarTabs } from "@/components/RadarTabs";
import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";
import { opportunityAnalytics, type Breakdown } from "@/lib/opportunity/analytics";
import { seedOpportunitiesIfEmpty, refreshOpportunities } from "@/lib/opportunity/seed";
import { seedRadarIfEmpty } from "@/lib/radar/seed";

export const dynamic = "force-dynamic";

function fmtK(n: number): string {
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;
}

function BreakdownTable({ title, rows }: { title: string; rows: Breakdown[] }): React.JSX.Element {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <section className="mb-6">
      <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}</h2>
      <div className="overflow-x-auto border border-border">
        <table className={tableCls}>
          <colgroup><col /><col style={{ width: "90px" }} /><col style={{ width: "90px" }} /><col style={{ width: "110px" }} /></colgroup>
          <thead className={theadCls}><tr><th className={thCls}>Segment</th><th className={`${thCls} text-right`}>Total</th><th className={`${thCls} text-right`}>Qualified</th><th className={`${thCls} text-right`}>Indic. value</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-[var(--row-rule)]">
                <td className="px-2.5 py-2">
                  <div className="text-foreground">{r.label}</div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded bg-[var(--bar)]"><div className="h-full bg-positive/60" style={{ width: `${Math.round((r.total / max) * 100)}%` }} /></div>
                </td>
                <td className="px-2.5 py-2 text-right tabular-nums">{r.total}</td>
                <td className="px-2.5 py-2 text-right tabular-nums text-tertiary-text">{r.qualified}</td>
                <td className="px-2.5 py-2 text-right tabular-nums text-meta">{r.valueHigh ? fmtK(r.valueHigh) : "—"}</td>
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
  const figures: Figure[] = [
    { label: "Discovered", value: t.discovered },
    { label: "Qualified", value: t.qualified, tone: "positive" },
    { label: "With target", value: t.withTarget },
    { label: "Outreach drafted", value: t.outreachDrafted, sep: true },
    { label: "Contacted", value: t.contacted, tone: t.contacted ? "attention" : "default" },
    { label: "Won", value: t.won, tone: t.won ? "positive" : "default" },
  ];
  const funnelMax = Math.max(1, ...a.funnel.map((f) => f.count));

  return (
    <main className="p-6">
      <header className="mb-4"><h1 className="text-[22px] font-medium tracking-tight">Opportunity Radar</h1><p className="text-[12.5px] text-meta">Analytics — the pipeline from signal to revenue.</p></header>
      <RadarTabs />

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
        <p className="mt-2 text-[11.5px] text-meta">Indicative pipeline (qualified, not lost): <span className="text-tertiary-text">{fmtK(t.indicativePipelineHigh)}</span> — a coarse sum of indicative value ranges, never booked revenue. Won reflects opportunities marked won in Radar.</p>
      </section>

      <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
        <div><BreakdownTable title="By source" rows={a.bySource} /><BreakdownTable title="By type" rows={a.byKind} /></div>
        <div><BreakdownTable title="By jurisdiction" rows={a.byJurisdiction} /></div>
      </div>
    </main>
  );
}
