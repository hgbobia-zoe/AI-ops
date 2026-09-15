// Financial Intelligence (MVP3) — Nocturne. Operational control, not accounting: "ahead or behind
// plan? revenue or labor?" Every number is deterministic or explicitly UNAVAILABLE (never invented,
// never a zeroed cost). Data unchanged.

import Link from "next/link";
import { financeForPeriod } from "@/lib/finance/service";
import { getPeriod, PERIOD_KEYS, type PeriodKey } from "@/lib/finance/periods";
import type { Variance } from "@/lib/finance/calc";
import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";

export const dynamic = "force-dynamic";

const money = (n: number | null | undefined): string => (n == null ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US"));
const hrs = (n: number | null): string => (n == null ? "—" : `${n} h`);
const pct = (n: number | null): string => (n == null ? "—" : `${Math.round(n * 100)}%`);

function VarianceTag({ v, kind }: { v: Variance; kind: "money" | "hours" }): React.JSX.Element {
  if (v.variance == null) return <span className="text-meta">—</span>;
  const cls = v.favorable == null ? "text-meta" : v.favorable ? "text-positive" : "text-critical";
  const val = kind === "money" ? money(v.variance) : hrs(v.variance);
  const sign = v.variance > 0 ? "+" : "";
  return <span className={`tabular-nums ${cls}`}>{sign}{val}{v.variancePct != null ? ` (${sign}${pct(v.variancePct).replace("%", "")}%)` : ""}</span>;
}

const Unavail = (): React.JSX.Element => <span className="text-meta">Unavailable</span>;

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ period?: string }> }): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const key: PeriodKey = (PERIOD_KEYS as string[]).includes(sp?.period ?? "") ? (sp!.period as PeriodKey) : "thisWeek";
  const period = getPeriod(key);
  const s = await financeForPeriod(period);

  const figures: Figure[] = [
    { label: "Signed", value: s.revenue.signed == null ? "—" : money(s.revenue.signed) },
    { label: "Target", value: s.revenue.target == null ? "—" : money(s.revenue.target) },
    { label: "Vs target", value: s.revenue.vsTarget.variance == null ? "—" : `${s.revenue.vsTarget.variance > 0 ? "+" : ""}${money(s.revenue.vsTarget.variance)}`, tone: s.revenue.vsTarget.favorable === false ? "critical" : s.revenue.vsTarget.favorable ? "positive" : "default" },
    { label: "Pipeline", value: s.revenue.pipeline == null ? "—" : money(s.revenue.pipeline), sep: true },
    { label: "Open quotes", value: s.revenue.pipelineCount ?? 0 },
  ];

  return (
    <main className="p-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Financial</h1>
          <p className="text-[12.5px] text-meta">{period.label} · {period.start} → {period.end}</p>
        </div>
        <FigureStrip figures={figures} />
      </header>

      {/* Period tabs */}
      <nav className="mb-5 flex flex-wrap gap-4 border-b border-border pb-2">
        {PERIOD_KEYS.map((k) => {
          const active = k === key;
          return (
            <Link key={k} href={k === "thisWeek" ? "/finance" : `/finance?period=${k}`} className={`text-[13.5px] transition-colors ${active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {getPeriod(k).label}
            </Link>
          );
        })}
      </nav>

      {!s.laborVerified && (
        <p className="mb-5 text-[12.5px] text-attention">Connecteam labor data is unavailable, so labor figures are marked unavailable — not zero. Actual hours are unknown, not zero.</p>
      )}

      {/* Three figure blocks */}
      <section className="mb-8 grid gap-px overflow-hidden border border-border bg-border md:grid-cols-3">
        <Block title="Revenue" tag="signed" headline={s.revenue.signed == null ? <Unavail /> : money(s.revenue.signed)}>
          <BRow label="Target">{s.revenue.target == null ? <span className="text-meta">Not configured</span> : money(s.revenue.target)}</BRow>
          <BRow label="Vs target"><VarianceTag v={s.revenue.vsTarget} kind="money" /></BRow>
          <BRow label="Signed events">{s.revenue.events || "—"}</BRow>
          <BRow label="Pipeline">{s.revenue.pipeline == null ? "—" : <span className="text-tertiary-text">{money(s.revenue.pipeline)} · {s.revenue.pipelineCount}</span>}</BRow>
        </Block>

        <Block title="Labor" tag={s.labor.rateStatus === "UNAVAILABLE" ? "hours only" : "cost"} headline={s.labor.actualCost == null ? (s.labor.plannedCost == null ? <Unavail /> : money(s.labor.plannedCost)) : money(s.labor.actualCost)}>
          <BRow label="Planned">{money(s.labor.plannedCost)}</BRow>
          <BRow label="Actual">{money(s.labor.actualCost)}</BRow>
          <BRow label="Cost var."><VarianceTag v={s.labor.costVariance} kind="money" /></BRow>
          <BRow label="Hours p/a">{hrs(s.labor.plannedHours)} / {hrs(s.labor.actualHours)}</BRow>
          {s.labor.pctOfRevenue != null && <BRow label="% of rev">{pct(s.labor.pctOfRevenue)}</BRow>}
        </Block>

        <Block title="Margin" tag="projected" headline={s.contribution.value == null ? <Unavail /> : money(s.contribution.value)}>
          <BRow label="Margin">{s.contribution.marginPct == null ? <Unavail /> : pct(s.contribution.marginPct)}</BRow>
          <BRow label="Signed − labor">{s.contribution.value == null ? <span className="text-meta">needs revenue + labor</span> : money(s.contribution.value)}</BRow>
        </Block>
      </section>

      {/* Events */}
      <section>
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Events this period</h2>
        {s.events.length === 0 ? (
          <p className="text-[13.5px] text-muted-foreground">No events with financial data in this period yet.</p>
        ) : (
          <div className="overflow-x-auto border border-border">
            <table className={tableCls}>
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>Event</th>
                  <th className={thCls}>Date</th>
                  <th className={`${thCls} text-right`}>Revenue</th>
                  <th className={`${thCls} text-right`}>Labor</th>
                  <th className={`${thCls} text-right`}>Contribution</th>
                </tr>
              </thead>
              <tbody>
                {s.events.map((e) => (
                  <tr key={e.eventId} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
                    <td className="px-2.5 py-2.5">{e.label || `Event ${e.eventId}`}</td>
                    <td className="px-2.5 py-2.5 text-meta">{e.date}</td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums">{e.revenue == null ? <Unavail /> : money(e.revenue)}</td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums">{e.labor != null ? money(e.labor) : <span className="text-meta">{e.laborStatus === "UNAVAILABLE" ? "unavailable" : "—"}</span>}</td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums">{e.contribution != null ? <span className={e.contribution >= 0 ? "text-positive" : "text-critical"}>{money(e.contribution)}</span> : <span className="text-meta">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-[12px] text-meta">Per-event driver labor is allocated from Connecteam. Contribution = signed revenue − direct cost; it stays unavailable until labor resolves — never revenue with a zeroed cost.</p>
      </section>
    </main>
  );
}

function Block({ title, tag, headline, children }: { title: string; tag: string; headline: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="bg-panel p-4">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}</span>
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-meta">{tag}</span>
      </div>
      <div className="text-[28px] font-medium leading-none tabular-nums">{headline}</div>
      <dl className="mt-3">{children}</dl>
    </div>
  );
}
function BRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--row-rule)] py-1.5 text-[13px] first:border-t-0">
      <dt className="text-meta">{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}
