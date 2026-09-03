// Financial Intelligence (MVP3) — operational financial control center, not accounting.
// "Are we ahead or behind plan? Is revenue or labor the problem?" Every number is deterministic
// or explicitly DATA UNAVAILABLE — nothing is invented.

import Link from "next/link";
import { DollarSign, TrendingUp, Users, PieChart, AlertTriangle } from "lucide-react";
import { financeForPeriod } from "@/lib/finance/service";
import { getPeriod, PERIOD_KEYS, type PeriodKey } from "@/lib/finance/periods";
import type { Variance } from "@/lib/finance/calc";

export const dynamic = "force-dynamic";

const money = (n: number | null | undefined): string =>
  n == null ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
const hrs = (n: number | null): string => (n == null ? "—" : `${n} h`);
const pct = (n: number | null): string => (n == null ? "—" : `${Math.round(n * 100)}%`);

function VarianceTag({ v, kind }: { v: Variance; kind: "money" | "hours" }): React.JSX.Element {
  if (v.variance == null) return <span className="text-muted-foreground">—</span>;
  const good = v.favorable;
  const cls = good == null ? "text-muted-foreground" : good ? "text-emerald-300" : "text-red-300";
  const val = kind === "money" ? money(v.variance) : hrs(v.variance);
  const sign = v.variance > 0 ? "+" : "";
  return (
    <span className={`tabular-nums ${cls}`}>
      {sign}
      {val}
      {v.variancePct != null ? ` (${sign}${pct(v.variancePct).replace("%", "")}%)` : ""}
    </span>
  );
}

function Unavail(): React.JSX.Element {
  return <span className="border border-white/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Data unavailable</span>;
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const key: PeriodKey = (PERIOD_KEYS as string[]).includes(sp?.period ?? "") ? (sp!.period as PeriodKey) : "thisWeek";
  const period = getPeriod(key);
  const s = await financeForPeriod(period);

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <DollarSign className="size-7" /> Financial Intelligence
        </h1>
        <p className="text-sm text-muted-foreground">
          {period.label} · {period.start} → {period.end}
        </p>
      </header>

      {/* Period selector */}
      <nav className="mb-6 flex flex-wrap gap-1.5">
        {PERIOD_KEYS.map((k) => {
          const p = getPeriod(k);
          const active = k === key;
          return (
            <Link
              key={k}
              href={k === "thisWeek" ? "/finance" : `/finance?period=${k}`}
              className={`border px-3 py-1.5 text-sm ${active ? "border-foreground bg-white/[0.06] text-foreground" : "border-white/10 text-muted-foreground hover:text-foreground"}`}
            >
              {p.label}
            </Link>
          );
        })}
      </nav>

      {!s.laborVerified && (
        <div className="mb-6 flex items-start gap-2.5 border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>Connecteam labor data is unavailable, so labor figures below are marked unavailable — not zero.</span>
        </div>
      )}

      {/* Executive scorecard */}
      <section className="mb-8 grid gap-3 md:grid-cols-3">
        {/* Revenue */}
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <TrendingUp className="size-4" /> Revenue <span className="text-[10px] uppercase text-muted-foreground">signed</span>
          </div>
          <div className="text-2xl font-bold tabular-nums">{s.revenue.signed == null ? <Unavail /> : money(s.revenue.signed)}</div>
          <dl className="mt-3 space-y-1 text-sm">
            <Row label="Target">{s.revenue.target == null ? <span className="text-muted-foreground">Not configured</span> : money(s.revenue.target)}</Row>
            <Row label="vs target"><VarianceTag v={s.revenue.vsTarget} kind="money" /></Row>
            <Row label="Priced events">{s.revenue.events || "—"}</Row>
          </dl>
        </div>

        {/* Labor */}
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Users className="size-4" /> Labor {s.labor.rateStatus === "UNAVAILABLE" && <span className="text-[10px] uppercase text-muted-foreground">hours only</span>}
          </div>
          <div className="text-2xl font-bold tabular-nums">{s.labor.actualCost == null ? (s.labor.plannedCost == null ? <Unavail /> : money(s.labor.plannedCost)) : money(s.labor.actualCost)}</div>
          <dl className="mt-3 space-y-1 text-sm">
            <Row label="Planned cost">{money(s.labor.plannedCost)}</Row>
            <Row label="Actual cost">{money(s.labor.actualCost)}</Row>
            <Row label="Cost variance"><VarianceTag v={s.labor.costVariance} kind="money" /></Row>
            <Row label="Hours (plan/act)">{hrs(s.labor.plannedHours)} / {hrs(s.labor.actualHours)}</Row>
            <Row label="Hours variance"><VarianceTag v={s.labor.hoursVariance} kind="hours" /></Row>
            {s.labor.pctOfRevenue != null && <Row label="% of revenue">{pct(s.labor.pctOfRevenue)}</Row>}
          </dl>
          {s.labor.employeesMissingRate > 0 && (
            <p className="mt-2 text-[11px] text-amber-300/80">{s.labor.employeesMissingRate} employee(s) have no pay rate on file — excluded from cost.</p>
          )}
          {s.laborVerified && s.labor.actualHours == null && s.labor.plannedHours != null && (
            <p className="mt-2 text-[11px] text-muted-foreground">Actual hours need Connecteam time-clock use; showing the scheduled (planned) plan.</p>
          )}
        </div>

        {/* Contribution */}
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <PieChart className="size-4" /> Contribution <span className="text-[10px] uppercase text-muted-foreground">projected</span>
          </div>
          <div className="text-2xl font-bold tabular-nums">{s.contribution.value == null ? <Unavail /> : money(s.contribution.value)}</div>
          <dl className="mt-3 space-y-1 text-sm">
            <Row label="Margin">{s.contribution.marginPct == null ? <Unavail /> : pct(s.contribution.marginPct)}</Row>
            <Row label="Revenue − labor">{s.contribution.value == null ? "needs revenue" : money(s.contribution.value)}</Row>
          </dl>
        </div>
      </section>

      {/* Event profitability */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Events this period</h2>
        {s.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events with financial data in this period yet.</p>
        ) : (
          <div className="overflow-x-auto border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5">Event</th>
                  <th className="p-2.5">Date</th>
                  <th className="p-2.5 text-right">Revenue</th>
                  <th className="p-2.5 text-right">Labor</th>
                  <th className="p-2.5 text-right">Contribution</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {s.events.map((e) => (
                  <tr key={e.eventId}>
                    <td className="p-2.5">{e.label || `Event ${e.eventId}`}</td>
                    <td className="p-2.5 text-muted-foreground">{e.date}</td>
                    <td className="p-2.5 text-right tabular-nums">{e.revenue == null ? <Unavail /> : money(e.revenue)}</td>
                    <td className="p-2.5 text-right text-muted-foreground">not allocated</td>
                    <td className="p-2.5 text-right text-muted-foreground">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          Revenue comes from Goodshuffle contract totals. Per-event labor isn&apos;t allocated yet (Connecteam shifts aren&apos;t tied to
          specific events) — labor is tracked at the period level above.
        </p>
      </section>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
