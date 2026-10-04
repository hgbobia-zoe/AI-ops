// Financial Intelligence — Nocturne. Operational control, not accounting: "ahead or behind plan?
// revenue or labor?" Every number is deterministic or explicitly UNAVAILABLE (never invented, never a
// zeroed cost, never an estimate shown as an actual). FI-Phase 1–5: the labor ledger now carries the
// internal/temp split, non-customer buckets (travel/warehouse/unallocated), the measured Instawork
// premium, three reconciling period dimensions (week / operational cycle / project), a route bridge
// level, the reconciliation view, and per-number data lineage.

import Link from "next/link";
import { financeForPeriod } from "@/lib/finance/service";
import { getPeriod, PERIOD_KEYS, priorWeek, priorCycle, type PeriodKey } from "@/lib/finance/periods";
import { opsCycleConfig } from "@/lib/finance/config";
import { getRouteLaborCosts, getInstaworkLedger, getLaborReconciliation, getProjectLaborLineage, getLaborLedgerSummary } from "@/lib/db/repo";
import type { Variance } from "@/lib/finance/calc";
import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";

export const dynamic = "force-dynamic";

const money = (n: number | null | undefined): string => (n == null ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US"));
const hrs = (n: number | null): string => (n == null ? "—" : `${n} h`);
const pct = (n: number | null): string => (n == null ? "—" : `${Math.round(n * 100)}%`);

const VIEWS = ["overview", "week", "cycle", "routes", "projects", "labor", "instawork", "variance", "reconciliation"] as const;
type ViewKey = (typeof VIEWS)[number];
const VIEW_LABEL: Record<ViewKey, string> = {
  overview: "Overview",
  week: "Week",
  cycle: "Operational Cycle",
  routes: "Routes",
  projects: "Projects",
  labor: "Labor",
  instawork: "Instawork",
  variance: "Variance",
  reconciliation: "Reconciliation",
};

function VarianceTag({ v, kind }: { v: Variance; kind: "money" | "hours" }): React.JSX.Element {
  if (v.variance == null) return <span className="text-meta">—</span>;
  const cls = v.favorable == null ? "text-meta" : v.favorable ? "text-positive" : "text-critical";
  const val = kind === "money" ? money(v.variance) : hrs(v.variance);
  const sign = v.variance > 0 ? "+" : "";
  return <span className={`tabular-nums ${cls}`}>{sign}{val}{v.variancePct != null ? ` (${sign}${pct(v.variancePct).replace("%", "")}%)` : ""}</span>;
}

const Unavail = (): React.JSX.Element => <span className="text-meta">Unavailable</span>;

function MethodBadge({ method, confidence }: { method: string | null; confidence: string | null }): React.JSX.Element {
  if (!method) return <span className="text-meta">—</span>;
  const tone = method === "ACTUAL_STOP" ? "text-positive" : method === "DERIVED_STOP" ? "text-foreground" : "text-attention";
  const label = method === "ACTUAL_STOP" ? "Actual" : method === "DERIVED_STOP" ? "Derived" : method === "PLANNED" ? "Planned" : method === "UNALLOCATED" ? "Unalloc" : "Est.";
  return <span className={`text-[11px] uppercase tracking-[0.06em] ${tone}`}>{label}{confidence ? ` · ${confidence[0]}` : ""}</span>;
}

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ period?: string; view?: string; lineage?: string }> }): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const cycle = opsCycleConfig();
  const key: PeriodKey = (PERIOD_KEYS as string[]).includes(sp?.period ?? "") ? (sp!.period as PeriodKey) : "thisWeek";
  const view: ViewKey = (VIEWS as readonly string[]).includes(sp?.view ?? "") ? (sp!.view as ViewKey) : "overview";
  const period = getPeriod(key, undefined, cycle);
  const s = await financeForPeriod(period);
  const L = s.laborLedger;
  const href = (p: Partial<{ period: string; view: string; lineage: string }>): string => {
    const params = new URLSearchParams();
    const pk = p.period ?? key;
    const vw = p.view ?? view;
    if (pk !== "thisWeek") params.set("period", pk);
    if (vw !== "overview") params.set("view", vw);
    if (p.lineage) params.set("lineage", p.lineage);
    const q = params.toString();
    return q ? `/finance?${q}` : "/finance";
  };

  const tempHourShare = L.totalHours != null && L.totalHours > 0 && L.tempHours != null ? L.tempHours / L.totalHours : null;

  const figures: Figure[] = [
    { label: "Signed", value: s.revenue.signed == null ? "—" : money(s.revenue.signed) },
    { label: "Labor (attrib.)", value: L.totalCost == null ? "—" : money(L.totalCost) },
    { label: "Temp %", value: tempHourShare == null ? "—" : pct(tempHourShare), sep: true },
    { label: "Premium", value: L.tempPremium == null ? "—" : money(L.tempPremium), tone: L.tempPremium && L.tempPremium > 0 ? "attention" : "default" },
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

      {/* Period tabs (dimension A week + dimension B operational cycle + month) */}
      <nav className="mb-3 flex flex-wrap gap-4 border-b border-border pb-2">
        {PERIOD_KEYS.map((k) => {
          const active = k === key;
          return (
            <Link key={k} href={href({ period: k })} className={`text-[13.5px] transition-colors ${active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {getPeriod(k, undefined, cycle).label}
            </Link>
          );
        })}
      </nav>

      {/* View tabs */}
      <nav className="mb-5 flex flex-wrap gap-3">
        {VIEWS.map((v) => {
          const active = v === view;
          return (
            <Link key={v} href={href({ view: v })} className={`rounded px-2 py-1 text-[12.5px] transition-colors ${active ? "bg-panel font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {VIEW_LABEL[v]}
            </Link>
          );
        })}
      </nav>

      {!s.laborVerified && (
        <p className="mb-5 text-[12.5px] text-attention">Connecteam labor data is unavailable, so planned labor figures are marked unavailable — not zero. Actual hours are unknown, not zero.</p>
      )}

      {(view === "overview" || view === "week" || view === "cycle") && <Overview s={s} L={L} tempHourShare={tempHourShare} href={href} />}
      {view === "routes" && <Routes rows={getRouteLaborCosts(period.start, period.end)} href={href} />}
      {view === "projects" && <ProjectsTable events={s.events} href={href} />}
      {view === "labor" && <LaborView L={L} s={s} tempHourShare={tempHourShare} />}
      {view === "instawork" && <InstaworkView rows={getInstaworkLedger(period.start, period.end)} L={L} />}
      {view === "variance" && <VarianceView s={s} L={L} priorCost={priorLaborCost(period, cycle)} />}
      {view === "reconciliation" && <Reconciliation rows={getLaborReconciliation(period.start, period.end)} />}

      {sp?.lineage && <Lineage eventId={sp.lineage} label={s.events.find((e) => e.eventId === sp.lineage)?.label ?? sp.lineage} />}
    </main>
  );
}

function priorLaborCost(period: ReturnType<typeof getPeriod>, cycle: ReturnType<typeof opsCycleConfig>): { label: string; cost: number | null } {
  const prior = period.isCycle ? priorCycle(period, cycle) : priorWeek(period);
  return { label: prior.label, cost: getLaborLedgerSummary(prior.start, prior.end).totalCost };
}

// ── Overview (3 blocks + labor-ledger block + events) ──────────────────────────────────────────────
function Overview({ s, L, tempHourShare, href }: { s: Awaited<ReturnType<typeof financeForPeriod>>; L: Awaited<ReturnType<typeof financeForPeriod>>["laborLedger"]; tempHourShare: number | null; href: (p: Partial<{ view: string; lineage: string }>) => string }): React.JSX.Element {
  return (
    <>
      <section className="mb-6 grid gap-px overflow-hidden border border-border bg-border md:grid-cols-3">
        <Block title="Revenue" tag="signed" headline={s.revenue.signed == null ? <Unavail /> : money(s.revenue.signed)}>
          <BRow label="Target">{s.revenue.target == null ? <span className="text-meta">Not configured</span> : money(s.revenue.target)}</BRow>
          <BRow label="Vs target"><VarianceTag v={s.revenue.vsTarget} kind="money" /></BRow>
          <BRow label="Signed events">{s.revenue.events || "—"}</BRow>
          <BRow label="Pipeline">{s.revenue.pipeline == null ? "—" : <span className="text-tertiary-text">{money(s.revenue.pipeline)} · {s.revenue.pipelineCount}</span>}</BRow>
        </Block>

        <Block title="Labor (planned)" tag={s.labor.rateStatus === "UNAVAILABLE" ? "hours only" : "connecteam"} headline={s.labor.actualCost == null ? (s.labor.plannedCost == null ? <Unavail /> : money(s.labor.plannedCost)) : money(s.labor.actualCost)}>
          <BRow label="Planned">{money(s.labor.plannedCost)}</BRow>
          <BRow label="Actual">{money(s.labor.actualCost)}</BRow>
          <BRow label="Cost var."><VarianceTag v={s.labor.costVariance} kind="money" /></BRow>
          <BRow label="Hours p/a">{hrs(s.labor.plannedHours)} / {hrs(s.labor.actualHours)}</BRow>
        </Block>

        <Block title="Margin" tag="projected" headline={s.contribution.value == null ? <Unavail /> : money(s.contribution.value)}>
          <BRow label="Margin">{s.contribution.marginPct == null ? <Unavail /> : pct(s.contribution.marginPct)}</BRow>
          <BRow label="Signed − labor">{s.contribution.value == null ? <span className="text-meta">needs revenue + labor</span> : money(s.contribution.value)}</BRow>
        </Block>
      </section>

      <LedgerBlocks L={L} tempHourShare={tempHourShare} />

      <section className="mt-8">
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Projects this period</h2>
        <ProjectsTable events={s.events} href={href} />
      </section>
    </>
  );
}

function LedgerBlocks({ L, tempHourShare }: { L: Awaited<ReturnType<typeof financeForPeriod>>["laborLedger"]; tempHourShare: number | null }): React.JSX.Element {
  return (
    <section className="grid gap-px overflow-hidden border border-border bg-border md:grid-cols-3">
      <Block title="Attributed labor" tag="ledger" headline={L.totalCost == null ? <Unavail /> : money(L.totalCost)}>
        <BRow label="Internal">{L.internalCost == null ? "—" : `${money(L.internalCost)} · ${hrs(L.internalHours)}`}</BRow>
        <BRow label="Temp (Instawork)">{L.tempCost == null ? "—" : `${money(L.tempCost)} · ${hrs(L.tempHours)}`}</BRow>
        <BRow label="Temp % of hours">{tempHourShare == null ? "—" : pct(tempHourShare)}</BRow>
        {L.anyEstimated && <BRow label="Basis"><span className="text-meta">Estimated (planned grain)</span></BRow>}
      </Block>

      <Block title="Buckets" tag="customer vs non-customer" headline={money(L.byBucket.customer)}>
        <BRow label="Customer">{money(L.byBucket.customer)}</BRow>
        <BRow label="Travel (est.)">{money(L.byBucket.travel)}</BRow>
        <BRow label="Warehouse/prep">{money(L.byBucket.warehouse)}</BRow>
        <BRow label="Unallocated">{L.byBucket.unallocated > 0 ? <span className="text-attention">{money(L.byBucket.unallocated)}</span> : money(L.byBucket.unallocated)}</BRow>
      </Block>

      <Block title="Temp premium" tag="measured, not hardcoded" headline={L.tempPremium == null ? <Unavail /> : money(L.tempPremium)}>
        <BRow label="Avg internal $/h">{L.avgInternalRate == null ? "—" : money(L.avgInternalRate)}</BRow>
        <BRow label="Equiv. internal">{money(L.equivalentInternalCost)}</BRow>
        <BRow label="Necessary/avoidable"><span className="text-meta">Undetermined</span></BRow>
      </Block>
    </section>
  );
}

// ── Projects table (per-event economics, with method badge + lineage link) ─────────────────────────
function ProjectsTable({ events, href }: { events: Awaited<ReturnType<typeof financeForPeriod>>["events"]; href: (p: Partial<{ view: string; lineage: string }>) => string }): React.JSX.Element {
  if (events.length === 0) return <p className="text-[13.5px] text-muted-foreground">No projects with financial data in this period yet.</p>;
  return (
    <>
      <div className="overflow-x-auto border border-border">
        <table className={tableCls}>
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Project</th>
              <th className={thCls}>Date</th>
              <th className={`${thCls} text-right`}>Revenue</th>
              <th className={`${thCls} text-right`}>Labor</th>
              <th className={`${thCls} text-right`}>Int / Temp</th>
              <th className={thCls}>Method</th>
              <th className={`${thCls} text-right`}>Contribution</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.eventId} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
                <td className="px-2.5 py-2.5"><Link href={href({ view: "projects", lineage: e.eventId })} className="hover:underline">{e.label || `Project ${e.eventId}`}</Link></td>
                <td className="px-2.5 py-2.5 text-meta">{e.date}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums">{e.revenue == null ? <Unavail /> : money(e.revenue)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums">{e.labor != null ? money(e.labor) : <span className="text-meta">{e.laborStatus === "UNAVAILABLE" ? "unavailable" : "—"}</span>}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{e.internalLabor == null && e.tempLabor == null ? "—" : `${money(e.internalLabor)} / ${money(e.tempLabor)}`}</td>
                <td className="px-2.5 py-2.5"><MethodBadge method={e.method} confidence={e.confidence} /></td>
                <td className="px-2.5 py-2.5 text-right tabular-nums">{e.contribution != null ? <span className={e.contribution >= 0 ? "text-positive" : "text-critical"}>{money(e.contribution)}{e.contribStatus === "ESTIMATED" ? <span className="ml-1 text-[10px] uppercase text-meta">est</span> : null}</span> : <span className="text-meta">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[12px] text-meta">Project labor is attributed from the labor ledger down worker → route → stop → project. Today it is planned-grain (method PLANNED/Derived), labeled — never a fake ACTUAL. A project carries labor for BOTH its delivery and pickup visits (real labor, not double-counted). Click a project for its data lineage.</p>
    </>
  );
}

// ── Routes bridge view ─────────────────────────────────────────────────────────────────────────────
function Routes({ rows, href }: { rows: ReturnType<typeof getRouteLaborCosts>; href: (p: Partial<{ view: string; lineage: string }>) => string }): React.JSX.Element {
  if (rows.length === 0) return <p className="text-[13.5px] text-muted-foreground">No route labor attributed in this period yet.</p>;
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Route profitability (the bridge level)</h2>
      <div className="overflow-x-auto border border-border">
        <table className={tableCls}>
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Route</th>
              <th className={thCls}>Date</th>
              <th className={`${thCls} text-right`}>Projects</th>
              <th className={`${thCls} text-right`}>Customer</th>
              <th className={`${thCls} text-right`}>Travel</th>
              <th className={`${thCls} text-right`}>Warehouse</th>
              <th className={`${thCls} text-right`}>Unalloc</th>
              <th className={`${thCls} text-right`}>Int / Temp</th>
              <th className={`${thCls} text-right`}>Total labor</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.routeId} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
                <td className="px-2.5 py-2.5 font-mono text-[12px]">{r.routeId}</td>
                <td className="px-2.5 py-2.5 text-meta">{r.date}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{r.projectIds.length || "—"}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums">{money(r.customer)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{money(r.travel)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{money(r.warehouse)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums">{r.unallocated > 0 ? <span className="text-attention">{money(r.unallocated)}</span> : money(r.unallocated)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{money(r.internal)} / {money(r.temp)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums">{money(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[12px] text-meta">The route is the reconciliation anchor: a shift&apos;s cost is split across its routes by duration share, then each route carves travel + warehouse before attributing the customer remainder to its projects. Nothing is lost; unallocated is surfaced, not hidden.</p>
      <p className="mt-1 text-[12px] text-meta"><Link href={href({ view: "reconciliation" })} className="underline">See the full reconciliation →</Link></p>
    </section>
  );
}

// ── Labor (workforce) view ───────────────────────────────────────────────────────────────────────
function LaborView({ L, s, tempHourShare }: { L: Awaited<ReturnType<typeof financeForPeriod>>["laborLedger"]; s: Awaited<ReturnType<typeof financeForPeriod>>; tempHourShare: number | null }): React.JSX.Element {
  return (
    <>
      <LedgerBlocks L={L} tempHourShare={tempHourShare} />
      <section className="mt-6 grid gap-px overflow-hidden border border-border bg-border md:grid-cols-2">
        <Block title="Internal workforce" tag="connecteam" headline={`${L.internalWorkers}`}>
          <BRow label="Workers">{L.internalWorkers || "—"}</BRow>
          <BRow label="Hours">{hrs(L.internalHours)}</BRow>
          <BRow label="Cost">{money(L.internalCost)}</BRow>
          <BRow label="Avg $/h">{money(L.avgInternalRate)}</BRow>
        </Block>
        <Block title="Temp workforce" tag="instawork" headline={`${L.tempWorkers}`}>
          <BRow label="Workers">{L.tempWorkers || "—"}</BRow>
          <BRow label="Hours">{hrs(L.tempHours)}</BRow>
          <BRow label="Cost">{money(L.tempCost)}</BRow>
          <BRow label="Premium vs internal">{L.tempPremium == null ? "—" : money(L.tempPremium)}</BRow>
        </Block>
      </section>
      <p className="mt-3 text-[12px] text-meta">Internal is driver-grain today; field/prep labor via shift_assignments is the FI-Phase 4 upgrade seam. Necessary vs avoidable temp cost is <span className="text-foreground">Undetermined</span> until the staffing model&apos;s temp-reason classification is wired — never silently labeled necessary or avoidable. Planned-vs-actual sits in the <span className="text-foreground">Variance</span> view (Connecteam {money(s.labor.plannedCost)} planned).</p>
    </>
  );
}

// ── Instawork view ───────────────────────────────────────────────────────────────────────────────
function InstaworkView({ rows, L }: { rows: ReturnType<typeof getInstaworkLedger>; L: Awaited<ReturnType<typeof financeForPeriod>>["laborLedger"] }): React.JSX.Element {
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Temp (Instawork) labor</h2>
      {rows.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">No Instawork labor attributed to routes in this period.</p>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className={tableCls}>
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>Worker / gig</th>
                <th className={`${thCls} text-right`}>Hours</th>
                <th className={`${thCls} text-right`}>Base $/h</th>
                <th className={`${thCls} text-right`}>Cost</th>
                <th className={`${thCls} text-right`}>Routes</th>
                <th className={`${thCls} text-right`}>Projects</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.workerRef} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
                  <td className="px-2.5 py-2.5">{r.name || r.workerRef}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums">{hrs(r.hours)}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums">{money(r.rate)}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums">{money(r.cost)}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{r.routeIds.length}</td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{r.projectIds.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 grid gap-px overflow-hidden border border-border bg-border md:grid-cols-3">
        <Block title="Temp cost" tag="period" headline={money(L.tempCost)}><BRow label="Hours">{hrs(L.tempHours)}</BRow><BRow label="Workers">{L.tempWorkers || "—"}</BRow></Block>
        <Block title="Equivalent internal" tag="measured rate" headline={money(L.equivalentInternalCost)}><BRow label="Avg internal $/h">{money(L.avgInternalRate)}</BRow></Block>
        <Block title="Premium" tag="temp − equivalent" headline={L.tempPremium == null ? <Unavail /> : money(L.tempPremium)}><BRow label="Basis"><span className="text-meta">not a hardcoded 2x</span></BRow></Block>
      </div>
      <p className="mt-3 text-[12px] text-meta">Base price is the captured per-seat dollar figure; per-gig vs per-hour is UNCONFIRMED upstream, so verify against a real gig before trusting the hourly premium. A gig matching several routes is an availability match — its cost is partitioned to the routes served by duration share and single-counted, never counted once per matched route.</p>
    </section>
  );
}

// ── Variance view ───────────────────────────────────────────────────────────────────────────────
function VarianceView({ s, L, priorCost }: { s: Awaited<ReturnType<typeof financeForPeriod>>; L: Awaited<ReturnType<typeof financeForPeriod>>["laborLedger"]; priorCost: { label: string; cost: number | null } }): React.JSX.Element {
  const delta = L.totalCost != null && priorCost.cost != null ? Math.round((L.totalCost - priorCost.cost) * 100) / 100 : null;
  return (
    <section>
      <div className="grid gap-px overflow-hidden border border-border bg-border md:grid-cols-3">
        <Block title="Planned vs actual" tag="connecteam" headline={money(s.labor.actualCost)}>
          <BRow label="Planned">{money(s.labor.plannedCost)}</BRow>
          <BRow label="Actual">{money(s.labor.actualCost)}</BRow>
          <BRow label="Cost var."><VarianceTag v={s.labor.costVariance} kind="money" /></BRow>
          <BRow label="Hours var."><VarianceTag v={s.labor.hoursVariance} kind="hours" /></BRow>
        </Block>
        <Block title="Internal / temp (attributed)" tag="ledger" headline={money(L.totalCost)}>
          <BRow label="Internal">{money(L.internalCost)}</BRow>
          <BRow label="Temp">{money(L.tempCost)}</BRow>
          <BRow label="Premium">{money(L.tempPremium)}</BRow>
        </Block>
        <Block title={`Vs ${priorCost.label}`} tag="week-over-week" headline={delta == null ? <Unavail /> : <span className={delta > 0 ? "text-critical" : "text-positive"}>{delta > 0 ? "+" : ""}{money(delta)}</span>}>
          <BRow label="Prior labor">{money(priorCost.cost)}</BRow>
          <BRow label="This labor">{money(L.totalCost)}</BRow>
        </Block>
      </div>
      {s.laborTrajectory.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-[12px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Labor trajectory (plan → actual)</h3>
          <div className="overflow-x-auto border border-border">
            <table className={tableCls}>
              <thead className={theadCls}><tr><th className={thCls}>Captured</th><th className={`${thCls} text-right`}>Planned $</th><th className={`${thCls} text-right`}>Actual $</th></tr></thead>
              <tbody>
                {s.laborTrajectory.map((t, i) => (
                  <tr key={i} className="border-t border-[var(--row-rule)]"><td className="px-2.5 py-2 text-meta">{t.capturedAt.slice(0, 16).replace("T", " ")}</td><td className="px-2.5 py-2 text-right tabular-nums">{money(t.plannedCost)}</td><td className="px-2.5 py-2 text-right tabular-nums">{money(t.actualCost)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="mt-3 text-[12px] text-meta">WoW uses the calendar-week dimension for a stable baseline; an operational cycle compares to the prior cycle. The AI &quot;why&quot; line is dormant by default (rules calculate, AI only interprets).</p>
    </section>
  );
}

// ── Reconciliation view ─────────────────────────────────────────────────────────────────────────
function Reconciliation({ rows }: { rows: ReturnType<typeof getLaborReconciliation> }): React.JSX.Element {
  if (rows.length === 0) return <p className="text-[13.5px] text-muted-foreground">No labor leaves to reconcile in this period.</p>;
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Reconciliation — per worker / day</h2>
      <div className="overflow-x-auto border border-border">
        <table className={tableCls}>
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Worker</th>
              <th className={thCls}>Kind</th>
              <th className={thCls}>Day</th>
              <th className={`${thCls} text-right`}>Customer</th>
              <th className={`${thCls} text-right`}>Travel</th>
              <th className={`${thCls} text-right`}>Warehouse</th>
              <th className={`${thCls} text-right`}>Unalloc</th>
              <th className={`${thCls} text-right`}>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
                <td className="px-2.5 py-2.5">{r.name || r.workerRef}</td>
                <td className="px-2.5 py-2.5 text-meta">{r.kind}</td>
                <td className="px-2.5 py-2.5 text-meta">{r.day}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums">{money(r.customer)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{money(r.travel)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{money(r.warehouse)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums">{r.unallocated > 0 ? <span className="text-attention">{money(r.unallocated)}</span> : money(r.unallocated)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums font-medium">{money(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[12px] text-meta">Each row sums customer + travel + warehouse + unallocated = that worker/day&apos;s shift labor transaction — the dollar is conserved end-to-end, never double-counted. A non-zero unallocated is a surfaced signal (over-staffed, idle, or a data gap), not an error.</p>
    </section>
  );
}

// ── Data lineage panel (per-number) ────────────────────────────────────────────────────────────
function Lineage({ eventId, label }: { eventId: string; label: string }): React.JSX.Element {
  const leaves = getProjectLaborLineage(eventId);
  return (
    <section className="mt-8 border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-medium">Data lineage · {label}</h2>
      <p className="mb-3 text-[12px] text-meta">Every hop is a stored fact: worker → shift → route → rate × hours → attribution method → this project&apos;s share. A pure read, not a recomputation.</p>
      {leaves.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No labor leaves attributed to this project yet.</p>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className={tableCls}>
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>Day</th>
                <th className={thCls}>Worker</th>
                <th className={thCls}>Route</th>
                <th className={`${thCls} text-right`}>Rate</th>
                <th className={`${thCls} text-right`}>Hours</th>
                <th className={`${thCls} text-right`}>Amount</th>
                <th className={thCls}>Method</th>
              </tr>
            </thead>
            <tbody>
              {leaves.map((l, i) => (
                <tr key={i} className="border-t border-[var(--row-rule)]">
                  <td className="px-2.5 py-2 text-meta">{l.day}</td>
                  <td className="px-2.5 py-2">{l.note || l.workerRef} <span className="text-meta">({l.workerKind})</span></td>
                  <td className="px-2.5 py-2 font-mono text-[11px]">{l.routeId}</td>
                  <td className="px-2.5 py-2 text-right tabular-nums">{money(l.rate)}</td>
                  <td className="px-2.5 py-2 text-right tabular-nums">{hrs(l.hours)}</td>
                  <td className="px-2.5 py-2 text-right tabular-nums">{l.amount == null ? <span className="text-meta">unavail</span> : money(l.amount)}</td>
                  <td className="px-2.5 py-2"><MethodBadge method={l.method} confidence={l.confidence} /> <span className="text-[10px] uppercase text-meta">{l.amountStatus}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Block({ title, tag, headline, children }: { title: string; tag: string; headline: React.ReactNode; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="bg-panel p-4">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}</span>
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-meta">{tag}</span>
      </div>
      <div className="text-[28px] font-medium leading-none tabular-nums">{headline}</div>
      {children && <dl className="mt-3">{children}</dl>}
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
