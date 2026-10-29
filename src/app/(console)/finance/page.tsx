// Financial Intelligence — Nocturne. Operational control, not accounting: "ahead or behind plan?
// revenue or labor?" Every number is deterministic or explicitly UNAVAILABLE (never invented, never a
// zeroed cost, never an estimate shown as an actual). FI-Phase 1–5: the labor ledger carries the
// internal/temp split, non-customer buckets (travel/warehouse/unallocated), the measured Instawork
// premium, three reconciling period dimensions (week / operational cycle / project), a route bridge
// level, the reconciliation view, and per-number data lineage.
//
// Redesign (prompt 09_FINANCE): one clear header + one compact period control; the 11 views grouped
// into Overview / Analysis / Reconciliation (every ?view= deep link preserved, incl. the week/cycle
// Overview aliases); consistent metric cards that state label · amount · scope · basis · date basis ·
// freshness · verification state; signed revenue, planned labor, actual labor, attributed labor and
// contribution-after-labor each explicitly distinguished (contribution is NOT called net profit); the
// blade's local StatusBadge migrated onto the shared @/components/ui/status renderer. Presentation
// only — no formula, source-of-truth, rounding, cents or date change (those live in the FI engine).

import Link from "next/link";
import { DollarSign } from "lucide-react";
import { financeForPeriod, projectFinancials, projectHandlingEstimate, financeInsights } from "@/lib/finance/service";
import type { ProjectSnapshot } from "@/lib/finance/projectSnapshot";
import type { ItemHandlingEstimate } from "@/lib/finance/itemIntelligence";
import type { InsightsResult, InsightFact } from "@/lib/finance/insights";
import type { RevenueComponents } from "@/lib/finance/revenueModel";
import { getPeriod, PERIOD_KEYS, priorWeek, priorCycle, customRange, priorRange, type Period, type PeriodKey } from "@/lib/finance/periods";
import { opsCycleConfig } from "@/lib/finance/config";
import { getRouteLaborCosts, getInstaworkLedger, getLaborReconciliation, getProjectLaborLineage, getLaborLedgerSummary, getVisitReconciliation, getReconciliationRuns, getRecentReconciliationRuns, type ReconciliationRunRow } from "@/lib/db/repo";
import type { VarianceReason } from "@/lib/finance/reconciliationRun";
import { reconcileVisit, type VisitWindow } from "@/lib/finance/visitReconcile";
import { visitReconcileConfig } from "@/lib/finance/config";
import { formatClockTime } from "@/lib/dates";
import { listFinanceSavedViews } from "@/lib/finance/savedViews";
import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";
import { PageHeader } from "@/components/ui/page-header";
import { BladeMain } from "@/components/ui/layouts";
import { StatusBanner } from "@/components/ui/states";
import { BladeAgents } from "@/components/aiorg/BladeAgents";
import { FinanceDateRange } from "./FinanceDateRange";
import { FinanceSavedViews } from "./FinanceSavedViews";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { ManualCostEntry } from "./ManualCostEntry";
import {
  money, hrs, pct,
  VIEW_LABEL, VIEW_NAV_GROUPS, navKeyForView, isOverviewView, isViewKey, laborHeadline,
  type ViewKey,
} from "./viewModel";
import {
  Unavail, MetricCard, Block, BRow, VarianceValue, ContributionValue, DeltaValue,
  SnapshotStatus, PhaseTag, MethodTag,
} from "./FinanceCards";

export const dynamic = "force-dynamic";

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ period?: string; view?: string; lineage?: string; project?: string; start?: string; end?: string }> }): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const cycle = opsCycleConfig();
  const key: PeriodKey = (PERIOD_KEYS as string[]).includes(sp?.period ?? "") ? (sp!.period as PeriodKey) : "thisWeek";
  const view: ViewKey = isViewKey(sp?.view) ? (sp!.view as ViewKey) : "overview";
  const selectedProject = sp?.project?.trim() || null;
  // Stage 7b: an explicit ?start=&end= range (validated deterministically; a bad range → null → fall back to
  // the preset, never a throw). When present+valid it drives the whole blade exactly like a preset would.
  const custom: Period | null = customRange(sp?.start, sp?.end);
  const customActive = custom != null;
  const rangeInvalid = Boolean(sp?.start || sp?.end) && !customActive; // asked for a range but it didn't validate
  const period = custom ?? getPeriod(key, undefined, cycle);
  const s = await financeForPeriod(period);
  const L = s.laborLedger;
  const href = (p: Partial<{ period: string; view: string; lineage: string; project: string; start: string; end: string }>): string => {
    const params = new URLSearchParams();
    const vw = p.view ?? view;
    if (vw !== "overview") params.set("view", vw);
    // Date dimension: an explicit preset (p.period) clears any custom range; an explicit range (p.start/end)
    // clears the preset; otherwise preserve whatever is active now, so switching view keeps the range.
    if (p.period !== undefined) {
      if (p.period !== "thisWeek") params.set("period", p.period);
    } else if (p.start !== undefined || p.end !== undefined) {
      if (p.start) params.set("start", p.start);
      if (p.end) params.set("end", p.end);
    } else if (customActive) {
      params.set("start", period.start);
      params.set("end", period.end);
    } else if (key !== "thisWeek") {
      params.set("period", key);
    }
    if (p.lineage) params.set("lineage", p.lineage);
    if (p.project) params.set("project", p.project);
    const q = params.toString();
    return q ? `/finance?${q}` : "/finance";
  };
  // The non-date params the date-range / saved-views controls carry across (view + project). Saved views
  // additionally capture the active date dimension (preset or custom range).
  const carry: Record<string, string> = {};
  if (view !== "overview") carry.view = view;
  if (selectedProject) carry.project = selectedProject;
  const currentState: Record<string, string> = { ...carry };
  if (customActive) {
    currentState.start = period.start;
    currentState.end = period.end;
  } else if (key !== "thisWeek") {
    currentState.period = key;
  }
  const savedViews = listFinanceSavedViews().map((v) => ({ id: v.id, name: v.name, state: v.state as Record<string, string> }));
  // Per-project profitability snapshot (compute-on-read) — a deepening of /finance, not a new nav.
  const projectSnap = selectedProject ? projectFinancials(selectedProject) : null;
  // Stage 7a: the project's durable reconciliation-run history (snapshot→revision→final + variance-vs-prior).
  const projectRuns = selectedProject ? getReconciliationRuns(selectedProject) : [];
  // Stage 6: the project's provisional item-level handling-time estimate (titles only, no money).
  const projectHandling = selectedProject ? projectHandlingEstimate(selectedProject) : null;
  // Stage 7c: deterministic insight facts (+ dormant-safe AI interpretation) for the Insights view.
  const insights = !selectedProject && view === "insights" ? await financeInsights(period) : null;
  // $ redaction: the whole blade is owner/admin (proxy + nav gate on canSeeFinancials); this is the SAME
  // gate, re-checked here, that also governs who may add/edit/delete a manual cost. A non-financial role
  // never reaches this page, so every figure below is already behind the financial permission.
  const canSee = canSeeFinancials(await viewerRole());
  const canEditCost = canSee;

  const tempHourShare = L.totalHours != null && L.totalHours > 0 && L.tempHours != null ? L.tempHours / L.totalHours : null;

  const figures: Figure[] = [
    { label: "Signed", value: s.revenue.signed == null ? "—" : money(s.revenue.signed) },
    { label: "Labor (attrib.)", value: L.totalCost == null ? "—" : money(L.totalCost) },
    { label: "Temp %", value: tempHourShare == null ? "—" : pct(tempHourShare), sep: true },
    { label: "Premium", value: L.tempPremium == null ? "—" : money(L.tempPremium), tone: L.tempPremium && L.tempPremium > 0 ? "attention" : "default" },
  ];

  return (
    <BladeMain>
      <PageHeader
        icon={<DollarSign className="size-5" />}
        title="Financial Intelligence"
        subtitle={<>{period.label} · {period.start} → {period.end}</>}
        actions={<div className="min-w-0 max-w-full overflow-x-auto"><FigureStrip figures={figures} /></div>}
      />

      <BladeAgents blade="finance" className="mb-5" />

      {/* One compact period control: presets + custom range + saved views, on a single row. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border pb-3">
        <nav aria-label="Period presets" className="flex flex-wrap items-center gap-1">
          {PERIOD_KEYS.map((k) => {
            const active = !customActive && k === key;
            return (
              <Link
                key={k}
                href={href({ period: k })}
                aria-current={active ? "true" : undefined}
                className={`rounded px-2.5 py-1 text-[12.5px] transition-colors ${active ? "bg-panel font-medium text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-row-hover"}`}
              >
                {getPeriod(k, undefined, cycle).label}
              </Link>
            );
          })}
        </nav>
        <div className="flex flex-wrap items-center gap-4">
          <FinanceDateRange start={customActive ? period.start : null} end={customActive ? period.end : null} active={customActive} carry={carry} />
          <FinanceSavedViews views={savedViews} currentState={currentState} />
        </div>
      </div>
      {rangeInvalid && (
        <p className="mb-3 text-[12.5px] text-meta">That date range wasn&apos;t valid (check the order and bounds), so {getPeriod(key, undefined, cycle).label} is shown instead.</p>
      )}

      {/* Grouped view nav — Overview / Analysis / Reconciliation, not one undifferentiated dashboard.
          Every item is a working ?view= deep link; week/cycle aliases light the Overview tab. */}
      {!selectedProject && (
        <nav aria-label="Finance views" className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-3">
          {VIEW_NAV_GROUPS.map((g) => (
            <div key={g.label} className="flex items-center gap-2">
              <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-meta">{g.label}</span>
              <div className="flex flex-wrap items-center gap-1">
                {g.items.map((v) => {
                  const active = navKeyForView(view) === v;
                  return (
                    <Link
                      key={v}
                      href={href({ view: v })}
                      aria-current={active ? "page" : undefined}
                      className={`rounded px-2 py-1 text-[12.5px] transition-colors ${active ? "bg-panel font-medium text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-row-hover"}`}
                    >
                      {VIEW_LABEL[v]}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      )}

      {!s.laborVerified && (
        <StatusBanner tone="attention" title="Connecteam labor data is unavailable" className="mb-5">
          Planned labor figures are marked unavailable — not zero. Actual hours are unknown, not zero, until the Connecteam pull succeeds.
        </StatusBanner>
      )}

      {selectedProject ? (
        <ProjectDetail snap={projectSnap} id={selectedProject} runs={projectRuns} handling={projectHandling} backHref={href({ view: "projects", project: undefined })} canEdit={canEditCost} />
      ) : (
        <>
          {isOverviewView(view) && <Overview s={s} L={L} tempHourShare={tempHourShare} href={href} />}
          {view === "routes" && <Routes rows={getRouteLaborCosts(period.start, period.end)} href={href} />}
          {view === "projects" && <ProjectsTable events={s.events} href={href} />}
          {view === "labor" && <LaborView L={L} s={s} tempHourShare={tempHourShare} />}
          {view === "instawork" && <InstaworkView rows={getInstaworkLedger(period.start, period.end)} L={L} />}
          {view === "variance" && <VarianceView s={s} L={L} priorCost={priorLaborCost(period, cycle)} />}
          {view === "reconciliation" && <Reconciliation rows={getLaborReconciliation(period.start, period.end)} runs={getRecentReconciliationRuns(period.start, period.end)} href={href} />}
          {view === "visits" && <VisitReconciliationView rows={getVisitReconciliation(period.start, period.end)} />}
          {view === "insights" && insights && <InsightsView insights={insights} href={href} />}

          {sp?.lineage && <Lineage eventId={sp.lineage} label={s.events.find((e) => e.eventId === sp.lineage)?.label ?? sp.lineage} />}
        </>
      )}
    </BladeMain>
  );
}

function priorLaborCost(period: Period, cycle: ReturnType<typeof opsCycleConfig>): { label: string; cost: number | null } {
  // Custom range → the equal-length preceding window; cycle → prior cycle; else the prior Mon–Sun week.
  const prior = period.key === "custom" ? priorRange(period) : period.isCycle ? priorCycle(period, cycle) : priorWeek(period);
  return { label: prior.label, cost: getLaborLedgerSummary(prior.start, prior.end).totalCost };
}

// ── Overview ───────────────────────────────────────────────────────────────────────────────────────
function Overview({ s, L, tempHourShare, href }: { s: Awaited<ReturnType<typeof financeForPeriod>>; L: Awaited<ReturnType<typeof financeForPeriod>>["laborLedger"]; tempHourShare: number | null; href: (p: Partial<{ view: string; lineage: string; project: string }>) => string }): React.JSX.Element {
  const lh = laborHeadline(s.labor);
  const dateBasis = s.period.label;
  return (
    <>
      {/* Primary scorecard — signed revenue, labor (honest basis), contribution after labor. Each card
          states its accounting basis + verification state so no figure is mistaken for another. */}
      <section className="mb-6 grid gap-3 md:grid-cols-3">
        <MetricCard
          label="Signed revenue"
          value={s.revenue.signed == null ? <Unavail /> : money(s.revenue.signed)}
          scope={`${s.revenue.events || 0} signed event${s.revenue.events === 1 ? "" : "s"}`}
          basis="Signed contracts (booked)"
          dateBasis={dateBasis}
          state={s.revenue.signed == null ? { tone: "neutral", label: "Unavailable" } : { tone: "positive", label: "Signed" }}
        >
          <BRow label="Target">{s.revenue.target == null ? <span className="text-meta">Not configured</span> : money(s.revenue.target)}</BRow>
          <BRow label="Vs target"><VarianceValue v={s.revenue.vsTarget} kind="money" /></BRow>
          <BRow label="Pipeline (unsigned)">{s.revenue.pipeline == null ? "—" : <span className="text-tertiary-text">{money(s.revenue.pipeline)} · {s.revenue.pipelineCount}</span>}</BRow>
        </MetricCard>

        <MetricCard
          label="Labor"
          value={lh.amount == null ? <Unavail /> : money(lh.amount)}
          scope={lh.basis === "actual" ? hrs(s.labor.actualHours) + " actual" : lh.basis === "planned" ? hrs(s.labor.plannedHours) + " planned" : "hours unknown"}
          basis={`${lh.basisLabel} — ${lh.basisDetail}`}
          dateBasis={dateBasis}
          state={lh.state}
        >
          <BRow label="Planned">{money(s.labor.plannedCost)}</BRow>
          <BRow label="Actual">{money(s.labor.actualCost)}</BRow>
          <BRow label="Cost variance"><VarianceValue v={s.labor.costVariance} kind="money" /></BRow>
          <BRow label="Hours planned / actual">{hrs(s.labor.plannedHours)} / {hrs(s.labor.actualHours)}</BRow>
        </MetricCard>

        <MetricCard
          label="Contribution after labor"
          value={<ContributionValue value={s.contribution.value} />}
          scope="Signed revenue − actual labor"
          basis="Projected (labor-only)"
          dateBasis={dateBasis}
          state={s.contribution.value == null ? { tone: "neutral", label: "Unavailable" } : { tone: "info", label: "Projected" }}
          footnote="Contribution after LABOR only — not net profit. It excludes vehicle, fuel, sub-rental, subcontractor and other direct costs. Open a project for its full direct-cost profitability."
        >
          <BRow label="Margin (of signed)">{s.contribution.marginPct == null ? <Unavail /> : pct(s.contribution.marginPct)}</BRow>
          <BRow label="Signed − labor">{s.contribution.value == null ? <span className="text-meta">needs revenue + labor</span> : money(s.contribution.value)}</BRow>
        </MetricCard>
      </section>

      <AttributedLaborSection L={L} tempHourShare={tempHourShare} />

      <section className="mt-8">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Projects this period</h2>
          <Link href={href({ view: "projects" })} className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Open Projects view →</Link>
        </div>
        <ProjectsTable events={s.events} href={href} />
      </section>
    </>
  );
}

// Attributed labor = what the deterministic worker→route→stop→project cascade REALIZED from the ledger.
// Distinct from the Connecteam planned/actual scorecard above (that is the whole-period plan vs clock;
// this is the share actually attributed down to customers/buckets). The header says so to keep them apart.
function AttributedLaborSection({ L, tempHourShare }: { L: Awaited<ReturnType<typeof financeForPeriod>>["laborLedger"]; tempHourShare: number | null }): React.JSX.Element {
  return (
    <section>
      <h2 className="mb-1 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Attributed labor <span className="text-[11px] normal-case tracking-normal text-meta">realized ledger, not the plan above</span></h2>
      <p className="mb-2 text-[12px] text-meta">The cost the worker → route → stop → project cascade actually attributed this period, split by workforce and bucket. Figures are planned-grain today (labeled), never a fabricated actual.</p>
      <LedgerBlocks L={L} tempHourShare={tempHourShare} />
    </section>
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
        <BRow label="Unallocated">{L.byBucket.unallocated > 0 ? <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-status-warning" aria-hidden />{money(L.byBucket.unallocated)}</span> : money(L.byBucket.unallocated)}</BRow>
      </Block>

      <Block title="Temp premium" tag="measured, not hardcoded" headline={L.tempPremium == null ? <Unavail /> : money(L.tempPremium)}>
        <BRow label="Avg internal $/h">{L.avgInternalRate == null ? "—" : money(L.avgInternalRate)}</BRow>
        <BRow label="Equiv. internal">{money(L.equivalentInternalCost)}</BRow>
        <BRow label="Necessary/avoidable"><span className="text-meta">Undetermined</span></BRow>
      </Block>
    </section>
  );
}

// ── Projects table (per-event economics, with method tag + lineage link) ────────────────────────────
function ProjectsTable({ events, href }: { events: Awaited<ReturnType<typeof financeForPeriod>>["events"]; href: (p: Partial<{ view: string; lineage: string; project: string }>) => string }): React.JSX.Element {
  if (events.length === 0) return <p className="text-[13.5px] text-muted-foreground">No projects with financial data in this period yet.</p>;
  return (
    <>
      <div className="overflow-x-auto border border-border">
        <table className={tableCls} style={{ minWidth: "760px" }}>
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
                <td className="px-2.5 py-2.5"><Link href={href({ view: "projects", project: e.eventId })} className="hover:underline">{e.label || `Project ${e.eventId}`}</Link></td>
                <td className="px-2.5 py-2.5 text-meta">{e.date}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground">{e.revenue == null ? <Unavail /> : money(e.revenue)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground">{e.labor != null ? money(e.labor) : <span className="text-meta">{e.laborStatus === "UNAVAILABLE" ? "unavailable" : "—"}</span>}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{e.internalLabor == null && e.tempLabor == null ? "—" : `${money(e.internalLabor)} / ${money(e.tempLabor)}`}</td>
                <td className="px-2.5 py-2.5"><MethodTag method={e.method} confidence={e.confidence} /></td>
                <td className="px-2.5 py-2.5 text-right"><span className="inline-flex justify-end"><ContributionValue value={e.contribution} estimated={e.contribStatus === "ESTIMATED"} /></span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[12px] text-meta">Contribution here is revenue − attributed labor only (not full profit). Project labor is attributed from the labor ledger down worker → route → stop → project; today it is planned-grain (method PLANNED/Derived), labeled — never a fake ACTUAL. A project carries labor for BOTH its delivery and pickup visits (real labor, not double-counted). Click a project for its full direct-cost profitability snapshot and data lineage.</p>
    </>
  );
}

// ── Per-project profitability snapshot (compute-on-read) ─────────────────────────────────────────────
const COST_FAMILY_LABEL: Record<string, string> = {
  labor: "Labor",
  vehicle: "Vehicle",
  fuel: "Fuel",
  subcontractor: "Subcontractor",
  sub_rental: "Sub-rental",
  consumables: "Consumables",
  event_expense: "Event expense",
  other: "Other",
};

// A reason tag is a DERIVED FACT (which input moved), never an inferred motive.
const REASON_LABEL: Record<VarianceReason, string> = {
  late_timesheet: "Late timesheet",
  labor_actualized: "Labor actualized",
  refund: "Refund / credit",
  payment_received: "Payment received",
  revenue_adjustment: "Revenue adjustment",
  manual_adjustment: "Manual adjustment",
  new_estimate: "New estimate",
  cost_removed: "Cost removed",
};

/** Per-project revision history — the snapshot→revision→final runs with the variance-vs-prior per line. */
function RevisionHistory({ runs }: { runs: ReconciliationRunRow[] }): React.JSX.Element {
  if (runs.length === 0) {
    return (
      <div className="mt-6">
        <h3 className="mb-1 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Reconciliation history</h3>
        <p className="text-[12.5px] text-meta">No reconciliation runs recorded yet. A run is captured on the finance scan once this project has ledger activity, and again whenever its numbers move (a late timesheet, a refund, a manual cost). Until then this is empty, not zero.</p>
      </div>
    );
  }
  return (
    <div className="mt-6">
      <h3 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Reconciliation history</h3>
      <p className="mb-3 text-[12px] text-meta">How this project&apos;s profitability settled over time. Each run is a point-in-time snapshot; a revision lists exactly what moved since the prior run and why. &quot;Final&quot; appears only when the project is fully reconciled (all cost actual, revenue collected) — never while anything is still estimated.</p>
      <ol className="space-y-3">
        {runs.map((run) => (
          <li key={run.id} className="border border-border bg-panel px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
              <span className="font-medium">Run {run.seq}</span>
              <PhaseTag phase={run.phase} />
              <SnapshotStatus status={run.status} />
              <span className="text-meta">{run.capturedAt.slice(0, 16).replace("T", " ")}</span>
              <span className="ml-auto flex flex-wrap items-center gap-x-4 tabular-nums">
                <span className="text-meta">Rev <span className="text-foreground">{money(run.revenue)}</span></span>
                <span className="text-meta">Cost <span className="text-foreground">{money(run.directCost)}</span></span>
                <span className="text-meta">Contrib <ContributionValue value={run.contribution} /></span>
                {!run.balanced && <span className="inline-flex items-center gap-1.5 text-status-label"><span className="size-1.5 rounded-full bg-status-blocked" aria-hidden />Unbalanced</span>}
              </span>
            </div>
            {run.variance && run.variance.lines.length > 0 ? (
              <ul className="mt-2 space-y-1 border-t border-[var(--row-rule)] pt-2 text-[12px]">
                {run.variance.lines.map((ln) => (
                  <li key={ln.line} className="flex flex-wrap items-center gap-x-3">
                    <span className="min-w-[150px] text-meta">{ln.label}</span>
                    <span className="tabular-nums text-tertiary-text">{money(ln.prior)} → {money(ln.current)}</span>
                    <span className="tabular-nums"><DeltaValue delta={ln.delta} /></span>
                    <span className="text-[11px] uppercase tracking-[0.06em] text-meta">{REASON_LABEL[ln.reason]}</span>
                  </li>
                ))}
              </ul>
            ) : run.variance ? (
              <p className="mt-2 border-t border-[var(--row-rule)] pt-2 text-[11.5px] text-meta">Status/lifecycle change only — no line figures moved since the prior run.</p>
            ) : (
              <p className="mt-2 border-t border-[var(--row-rule)] pt-2 text-[11.5px] text-meta">First run — the baseline for later variance.</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ProjectDetail({ snap, id, runs, handling, backHref, canEdit }: { snap: ProjectSnapshot | null; id: string; runs: ReconciliationRunRow[]; handling: ItemHandlingEstimate | null; backHref: string; canEdit: boolean }): React.JSX.Element {
  if (!snap) {
    return (
      <section>
        <p className="mb-3 text-[12.5px]"><Link href={backHref} className="text-muted-foreground underline hover:text-foreground">← Back to projects</Link></p>
        <p className="text-[13.5px] text-muted-foreground">Project <span className="font-mono">{id}</span> isn&apos;t in the bookings pull yet, so no profitability snapshot can be computed. It is not zero — it is unavailable until the next Goodshuffle pull.</p>
      </section>
    );
  }
  const r = snap.revenue;
  const freshness = snap.revenueAsOf ? `revenue as of ${snap.revenueAsOf.slice(0, 16).replace("T", " ")}` : undefined;
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="mb-1 text-[12.5px]"><Link href={backHref} className="text-muted-foreground underline hover:text-foreground">← Back to projects</Link></p>
          <h2 className="text-[18px] font-medium tracking-tight">{snap.label}</h2>
          <p className="flex flex-wrap items-center gap-2 text-[12px] text-meta">Project <span className="font-mono">{snap.projectId}</span>{snap.eventDate ? ` · ${snap.eventDate}` : ""} · <SnapshotStatus status={snap.status} /></p>
        </div>
      </div>

      {/* Headline economics */}
      <section className="mb-6 grid gap-3 md:grid-cols-3">
        <MetricCard
          label="Revenue"
          value={r.contracted == null ? <Unavail /> : money(r.contracted)}
          scope="Contracted total"
          basis={r.signed ? "Signed contract" : "Quote (unsigned)"}
          freshness={freshness}
          state={r.contracted == null ? { tone: "neutral", label: "Unavailable" } : r.signed ? { tone: "positive", label: "Signed" } : { tone: "attention", label: "Unsigned quote" }}
        >
          <BRow label="Subtotal (pre-discount)">{r.subtotal == null ? <Unavail /> : money(r.subtotal)}</BRow>
          <BRow label="Collected">{r.collected == null ? <Unavail /> : money(r.collected)}</BRow>
          <BRow label="Due">{r.due == null ? <Unavail /> : money(r.due)}</BRow>
        </MetricCard>
        <MetricCard
          label="Direct cost"
          value={snap.directCost == null ? <Unavail /> : money(snap.directCost)}
          scope="All tracked cost families"
          basis={snap.directCostStatus === "ACTUAL" ? "Actual" : snap.directCostStatus === "ESTIMATED" ? "Estimated" : "Unavailable"}
          state={snap.directCost == null ? { tone: "neutral", label: "Unavailable" } : snap.directCostStatus === "ACTUAL" ? { tone: "positive", label: "Actual" } : { tone: "attention", label: "Estimated" }}
        >
          {snap.costFamilies.filter((f) => f.tracked).map((f) => (
            <BRow key={f.type} label={COST_FAMILY_LABEL[f.type] ?? f.type}>{money(f.amount)}{f.status === "ESTIMATED" ? <span className="ml-1 text-[10px] uppercase text-meta">est</span> : null}</BRow>
          ))}
          {snap.costFamilies.every((f) => !f.tracked) && <BRow label="Tracked families"><span className="text-meta">None yet</span></BRow>}
        </MetricCard>
        <MetricCard
          label="Contribution"
          value={<ContributionValue value={snap.contribution} />}
          scope="Revenue − direct cost"
          basis="Full direct-cost profitability"
          state={snap.contribution == null ? { tone: "neutral", label: "Unavailable" } : snap.status === "RECONCILED" ? { tone: "positive", label: "Reconciled" } : { tone: "info", label: "Settling" }}
          footnote="This is full direct-cost contribution (every tracked cost family), unlike the overview's labor-only figure. Overhead is excluded by design."
        >
          <BRow label="Margin">{snap.marginPct == null ? <Unavail /> : pct(snap.marginPct)}</BRow>
        </MetricCard>
      </section>

      {/* Revenue components (Stage 3) — quoted→contracted→collected, discounts, tax, fees, refunds. Shown
          only when the per-tx Goodshuffle breakdown has been pulled; otherwise the grand-total headline above
          stands on its own (no regression). Untracked figures are unavailable, never shown as 0. */}
      {r.componentsTracked && r.components ? (
        <RevenueComponentsPanel c={r.components} />
      ) : (
        <p className="mb-6 text-[12px] text-meta">Revenue component breakdown (quoted vs contracted, discounts, tax, fees, refunds) is not available for this project yet — it populates after the office re-installs the Goodshuffle pull. Only the grand total is shown above.</p>
      )}

      {/* Cost-family rollup — tracked AND not-yet-tracked (never shown as 0) */}
      <h3 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Cost families</h3>
      <div className="overflow-x-auto border border-border">
        <table className={tableCls} style={{ minWidth: "640px" }}>
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Family</th>
              <th className={`${thCls} text-right`}>Amount</th>
              <th className={thCls}>Status</th>
              <th className={thCls}>Method</th>
              <th className={`${thCls} text-right`}>Leaves</th>
            </tr>
          </thead>
          <tbody>
            {snap.costFamilies.map((f) => (
              <tr key={f.type} className="border-t border-[var(--row-rule)]">
                <td className="px-2.5 py-2.5">{COST_FAMILY_LABEL[f.type] ?? f.type}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground">{f.amount == null ? <span className="text-meta">unavailable</span> : money(f.amount)}</td>
                <td className="px-2.5 py-2.5">{f.tracked ? <span className="text-[11px] uppercase tracking-[0.06em] text-meta">{f.status.toLowerCase()}</span> : <span className="text-[11px] uppercase tracking-[0.06em] text-meta">not tracked</span>}</td>
                <td className="px-2.5 py-2.5"><MethodTag method={f.method} confidence={f.confidence} /></td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{f.leafCount || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Reconciliation — the family parts sum back to the direct-cost total */}
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 border border-border bg-panel px-4 py-3 text-[12.5px]">
        <span className="text-meta">Reconciliation</span>
        <span className="text-meta">Family sum <span className="tabular-nums text-foreground">{money(snap.reconciliation.familySum)}</span></span>
        <span className="text-meta">Direct cost <span className="tabular-nums text-foreground">{money(snap.reconciliation.directCostTotal)}</span></span>
        <span className="text-meta">Residual <span className="tabular-nums text-foreground">{snap.reconciliation.residual == null ? "—" : money(snap.reconciliation.residual)}</span></span>
        {snap.reconciliation.balanced
          ? <span className="inline-flex items-center gap-1.5 text-status-label"><span className="size-1.5 rounded-full bg-status-ready" aria-hidden />Balanced</span>
          : <span className="inline-flex items-center gap-1.5 text-status-label"><span className="size-1.5 rounded-full bg-status-blocked" aria-hidden />Unbalanced</span>}
      </div>

      {/* Stage 6: item-level handling-time intelligence — PROVISIONAL, inferred from line-item titles only.
          Operational time for context; NOT a dollar cost and NOT part of the money math above. */}
      <HandlingEstimatePanel h={handling} />

      {/* Honest gaps */}
      <div className="mt-4">
        <h3 className="mb-1 text-[12px] font-medium uppercase tracking-[0.1em] text-tertiary-text">How to read this</h3>
        <p className="mb-2 text-[12.5px] text-meta">{snap.statusReason}{freshness ? ` · ${freshness}` : ""}</p>
        <ul className="list-disc space-y-1 pl-5 text-[12px] text-meta">
          {snap.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>

      {/* Manual cost entries (Stage 5, G9) — gated add/edit/delete; rolls into the families above. */}
      <ManualCostEntry projectId={snap.projectId} canEdit={canEdit} />

      {/* Reconciliation-run history (Stage 7a) — how this project's profitability settled over time. */}
      <RevisionHistory runs={runs} />

      {/* Existing per-number labor lineage (all attributed leaves, incl. non-customer buckets) */}
      <Lineage eventId={snap.projectId} label={snap.label} />
    </section>
  );
}

// ── Routes bridge view ───────────────────────────────────────────────────────────────────────────────
function Routes({ rows, href }: { rows: ReturnType<typeof getRouteLaborCosts>; href: (p: Partial<{ view: string; lineage: string }>) => string }): React.JSX.Element {
  if (rows.length === 0) return <p className="text-[13.5px] text-muted-foreground">No route labor attributed in this period yet.</p>;
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Route profitability (the bridge level)</h2>
      <div className="overflow-x-auto border border-border">
        <table className={tableCls} style={{ minWidth: "880px" }}>
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
                <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground">{money(r.customer)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{money(r.travel)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{money(r.warehouse)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums">{r.unallocated > 0 ? <span className="inline-flex items-center justify-end gap-1.5 text-foreground"><span className="size-1.5 rounded-full bg-status-warning" aria-hidden />{money(r.unallocated)}</span> : <span className="text-foreground">{money(r.unallocated)}</span>}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{money(r.internal)} / {money(r.temp)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground">{money(r.cost)}</td>
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

// ── Labor (workforce) view ─────────────────────────────────────────────────────────────────────────
function LaborView({ L, s, tempHourShare }: { L: Awaited<ReturnType<typeof financeForPeriod>>["laborLedger"]; s: Awaited<ReturnType<typeof financeForPeriod>>; tempHourShare: number | null }): React.JSX.Element {
  return (
    <>
      <AttributedLaborSection L={L} tempHourShare={tempHourShare} />
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

// ── Instawork view ───────────────────────────────────────────────────────────────────────────────────
function InstaworkView({ rows, L }: { rows: ReturnType<typeof getInstaworkLedger>; L: Awaited<ReturnType<typeof financeForPeriod>>["laborLedger"] }): React.JSX.Element {
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Temp (Instawork) labor</h2>
      {rows.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">No Instawork labor attributed to routes in this period.</p>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className={tableCls} style={{ minWidth: "640px" }}>
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
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground">{money(r.cost)}</td>
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

// ── Variance view ─────────────────────────────────────────────────────────────────────────────────────
function VarianceView({ s, L, priorCost }: { s: Awaited<ReturnType<typeof financeForPeriod>>; L: Awaited<ReturnType<typeof financeForPeriod>>["laborLedger"]; priorCost: { label: string; cost: number | null } }): React.JSX.Element {
  const delta = L.totalCost != null && priorCost.cost != null ? Math.round((L.totalCost - priorCost.cost) * 100) / 100 : null;
  return (
    <section>
      <div className="grid gap-px overflow-hidden border border-border bg-border md:grid-cols-3">
        <Block title="Planned vs actual" tag="connecteam" headline={money(s.labor.actualCost)}>
          <BRow label="Planned">{money(s.labor.plannedCost)}</BRow>
          <BRow label="Actual">{money(s.labor.actualCost)}</BRow>
          <BRow label="Cost var."><VarianceValue v={s.labor.costVariance} kind="money" /></BRow>
          <BRow label="Hours var."><VarianceValue v={s.labor.hoursVariance} kind="hours" /></BRow>
        </Block>
        <Block title="Internal / temp (attributed)" tag="ledger" headline={money(L.totalCost)}>
          <BRow label="Internal">{money(L.internalCost)}</BRow>
          <BRow label="Temp">{money(L.tempCost)}</BRow>
          <BRow label="Premium">{money(L.tempPremium)}</BRow>
        </Block>
        <Block title={`Vs ${priorCost.label}`} tag="week-over-week" headline={<DeltaValue delta={delta} lowerIsBetter />}>
          <BRow label="Prior labor">{money(priorCost.cost)}</BRow>
          <BRow label="This labor">{money(L.totalCost)}</BRow>
        </Block>
      </div>
      {s.laborTrajectory.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-[12px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Labor trajectory (plan → actual)</h3>
          <div className="overflow-x-auto border border-border">
            <table className={tableCls} style={{ minWidth: "480px" }}>
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

// ── Reconciliation view ───────────────────────────────────────────────────────────────────────────────
function Reconciliation({ rows, runs, href }: { rows: ReturnType<typeof getLaborReconciliation>; runs: ReconciliationRunRow[]; href: (p: Partial<{ view: string; project: string }>) => string }): React.JSX.Element {
  if (rows.length === 0 && runs.length === 0) return <p className="text-[13.5px] text-muted-foreground">No labor leaves to reconcile in this period.</p>;
  return (
    <section className="space-y-8">
      {/* Stage 7a: per-project reconciliation RUNS — the snapshot→revision→final lifecycle for the period. */}
      <div>
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Reconciliation runs — how profitability settled</h2>
        {runs.length === 0 ? (
          <p className="text-[12.5px] text-meta">No reconciliation runs landed in this period yet. Runs are captured on the finance scan as each project&apos;s ledger moves; they record late timesheets, refunds and manual costs as revisions over time.</p>
        ) : (
          <>
            <div className="overflow-x-auto border border-border">
              <table className={tableCls} style={{ minWidth: "900px" }}>
                <thead className={theadCls}>
                  <tr>
                    <th className={thCls}>Project</th>
                    <th className={thCls}>Phase</th>
                    <th className={thCls}>Status</th>
                    <th className={`${thCls} text-right`}>Run</th>
                    <th className={`${thCls} text-right`}>Revenue</th>
                    <th className={`${thCls} text-right`}>Direct cost</th>
                    <th className={`${thCls} text-right`}>Contribution</th>
                    <th className={thCls}>Last change</th>
                    <th className={thCls}>Captured</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const topLine = run.variance?.lines[0] ?? null;
                    return (
                      <tr key={run.id} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
                        <td className="px-2.5 py-2.5"><Link href={href({ view: "projects", project: run.projectId })} className="underline decoration-dotted underline-offset-2">{run.snapshot.label}</Link></td>
                        <td className="px-2.5 py-2.5"><PhaseTag phase={run.phase} /></td>
                        <td className="px-2.5 py-2.5"><SnapshotStatus status={run.status} /></td>
                        <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{run.seq}</td>
                        <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground">{money(run.revenue)}</td>
                        <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground">{money(run.directCost)}</td>
                        <td className="px-2.5 py-2.5 text-right"><span className="inline-flex justify-end"><ContributionValue value={run.contribution} /></span></td>
                        <td className="px-2.5 py-2.5 text-[11.5px]">{topLine ? <span className="inline-flex items-center gap-2"><span className="text-meta uppercase tracking-[0.06em]">{REASON_LABEL[topLine.reason]}</span> <DeltaValue delta={topLine.delta} /></span> : <span className="text-meta">baseline</span>}</td>
                        <td className="px-2.5 py-2.5 text-meta">{run.capturedAt.slice(0, 16).replace("T", " ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[12px] text-meta">One row per project = its latest run in this window. Open a project for its full revision history + the per-line variance. A run ties internally: its cost families sum to the direct-cost total (an unbalanced run is flagged), and it carries the overall settlement status.</p>
          </>
        )}
      </div>

      {rows.length > 0 && (
      <div>
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Reconciliation — per worker / day</h2>
      <div className="overflow-x-auto border border-border">
        <table className={tableCls} style={{ minWidth: "760px" }}>
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
                <td className="px-2.5 py-2.5 text-right tabular-nums text-foreground">{money(r.customer)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{money(r.travel)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{money(r.warehouse)}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums">{r.unallocated > 0 ? <span className="inline-flex items-center justify-end gap-1.5 text-foreground"><span className="size-1.5 rounded-full bg-status-warning" aria-hidden />{money(r.unallocated)}</span> : <span className="text-foreground">{money(r.unallocated)}</span>}</td>
                <td className="px-2.5 py-2.5 text-right tabular-nums font-medium text-foreground">{money(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[12px] text-meta">Each row sums customer + travel + warehouse + unallocated = that worker/day&apos;s shift labor transaction — the dollar is conserved end-to-end, never double-counted. A non-zero unallocated is a surfaced signal (over-staffed, idle, or a data gap), not an error.</p>
      </div>
      )}
    </section>
  );
}

// ── Visit reconciliation (GPS vs dispatch) view (FI Stage 4) ───────────────────────────────────────────
const VISIT_LABEL_TEXT: Record<string, string> = {
  GPS_DISPATCH: "GPS + dispatch",
  GPS_CONFIRMED: "GPS only",
  DISPATCH_FLAGGED: "Flagged",
  DISPATCH_ONLY: "Dispatch only",
  NONE: "No evidence",
};
const VISIT_LABEL_DOT: Record<string, string> = {
  GPS_DISPATCH: "bg-status-ready",
  GPS_CONFIRMED: "bg-status-ready",
  DISPATCH_FLAGGED: "bg-status-blocked",
  DISPATCH_ONLY: "bg-status-warning",
  NONE: "bg-status-neutral",
};
const win = (enter: string | null, exit: string | null): string => {
  const a = enter ? formatClockTime(enter) : "—";
  const b = exit ? formatClockTime(exit) : "open";
  return enter || exit ? `${a} → ${b}` : "—";
};

function VisitReconciliationView({ rows }: { rows: ReturnType<typeof getVisitReconciliation> }): React.JSX.Element {
  const cfg = visitReconcileConfig();
  const reconciled = rows.map((r) => {
    const gps: VisitWindow | null = r.gpsEnter || r.gpsExit
      ? { stopId: r.stopId, routeId: r.routeId, txId: r.txId ?? undefined, source: "gps", enterTs: r.gpsEnter, exitTs: r.gpsExit, confidence: (r.gpsConfidence as VisitWindow["confidence"]) ?? "MEDIUM" }
      : null;
    const dispatch: VisitWindow | null = r.dispatchEnter || r.dispatchExit
      ? { stopId: r.stopId, routeId: r.routeId, txId: r.txId ?? undefined, source: "dispatch", enterTs: r.dispatchEnter, exitTs: r.dispatchExit, confidence: "LOW" }
      : null;
    return { r, v: reconcileVisit(gps, dispatch, cfg.visitDiscrepancyMinutes, { stopId: r.stopId, routeId: r.routeId, txId: r.txId ?? undefined }) };
  });
  const gpsCount = reconciled.filter((x) => x.v.gps != null).length;
  const flagged = reconciled.filter((x) => x.v.flagged).length;

  return (
    <section>
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">On-site visits — GPS vs dispatch</h2>
      <div className="mb-3 rounded border border-border bg-panel px-4 py-3 text-[12.5px] text-meta">
        Two independent on-site evidence sources. <span className="text-foreground">GPS</span> = the truck was physically inside the stop&apos;s geofence (polled fixes). <span className="text-foreground">Dispatch</span> = the crew&apos;s arrived/completed taps (server-receive times, so offline-queue skew is possible). GPS presence is <span className="text-foreground">forward-only</span> and only exists from when polling began; historical and un-polled visits are <span className="text-foreground">dispatch-only</span> and labeled PROVISIONAL. A dispatch time alone never counts as a confirmed on-site clock.
      </div>
      {rows.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">No visit evidence recorded in this period yet. Dispatch windows appear once stops are marked arrived/completed; GPS windows appear once position polling is configured and running.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px]">
            <span className="text-meta">Stops with evidence <span className="tabular-nums text-foreground">{rows.length}</span></span>
            <span className="text-meta">GPS-confirmed <span className="tabular-nums text-foreground">{gpsCount}</span></span>
            <span className="text-meta">Flagged for review <span className="tabular-nums text-foreground">{flagged}</span></span>
          </div>
          <div className="overflow-x-auto border border-border">
            <table className={tableCls} style={{ minWidth: "860px" }}>
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>Stop</th>
                  <th className={thCls}>Date</th>
                  <th className={thCls}>GPS window</th>
                  <th className={thCls}>Dispatch window</th>
                  <th className={thCls}>Authoritative</th>
                  <th className={`${thCls} text-right`}>Δ (min)</th>
                  <th className={thCls}>Label</th>
                  <th className={thCls}>Conf.</th>
                </tr>
              </thead>
              <tbody>
                {reconciled.map(({ r, v }) => (
                  <tr key={r.stopId} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
                    <td className="px-2.5 py-2.5">{r.custName || r.stopId}{r.kind ? <span className="ml-1 text-[10px] uppercase text-meta">{r.kind}</span> : null}</td>
                    <td className="px-2.5 py-2.5 text-meta">{r.day}</td>
                    <td className="px-2.5 py-2.5 tabular-nums">{v.gps ? win(v.gps.enterTs, v.gps.exitTs) : <span className="text-meta">—</span>}</td>
                    <td className="px-2.5 py-2.5 tabular-nums">{v.dispatch ? win(v.dispatch.enterTs, v.dispatch.exitTs) : <span className="text-meta">—</span>}</td>
                    <td className="px-2.5 py-2.5 tabular-nums">{v.authoritative ? `${win(v.authoritative.enterTs, v.authoritative.exitTs)}` : <span className="text-meta">—</span>}{v.authoritative ? <span className="ml-1 text-[10px] uppercase text-meta">{v.authoritative.source}</span> : null}</td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums">{v.discrepancyMinutes == null ? "—" : Math.round(v.discrepancyMinutes)}</td>
                    <td className="px-2.5 py-2.5"><span className="inline-flex items-center gap-1.5 text-[12px] text-status-label"><span className={`size-1.5 shrink-0 rounded-full ${VISIT_LABEL_DOT[v.label] ?? "bg-status-neutral"}`} aria-hidden />{VISIT_LABEL_TEXT[v.label] ?? v.label}</span></td>
                    <td className="px-2.5 py-2.5 text-meta">{v.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[12px] text-meta">When GPS and dispatch agree within {cfg.visitDiscrepancyMinutes} min, the authoritative window is GPS enter → dispatch complete. Beyond that they are flagged and the dispatch window is kept as the labeled default (the crew action is the billing anchor). Only a genuine GPS dwell lifts a project&apos;s labor to the ACTUAL_STOP method — dispatch alone never does, so it stays Derived/Planned, honestly labeled.</p>
        </>
      )}
    </section>
  );
}

// ── Item-level handling-time estimate (FI Stage 6) — PROVISIONAL, titles-only, no money ───────────────
function fmtMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function HandlingEstimatePanel({ h }: { h: ItemHandlingEstimate | null }): React.JSX.Element {
  return (
    <div className="mt-6">
      <h3 className="mb-1 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Estimated handling time <span className="text-[11px] normal-case tracking-normal text-meta">provisional, from item titles</span></h3>
      {!h || !h.available ? (
        <p className="text-[12.5px] text-meta">No line-item titles captured for this project yet, so an operational-time estimate is unavailable (not zero). Titles populate on the Goodshuffle pull.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border border-border bg-panel px-4 py-3 text-[12.5px]">
            <span className="text-meta">Setup <span className="tabular-nums text-foreground">{fmtMinutes(h.setupMinutes)}</span></span>
            <span className="text-meta">Breakdown <span className="tabular-nums text-foreground">{fmtMinutes(h.breakdownMinutes)}</span></span>
            <span className="text-meta">Total crew-minutes <span className="tabular-nums text-foreground">{fmtMinutes(h.totalMinutes)}</span></span>
            <span className="text-meta">Items <span className="tabular-nums text-foreground">{h.itemCount}</span></span>
            <span className="ml-auto text-[11px] uppercase tracking-[0.06em] text-meta">Confidence {h.confidence}</span>
          </div>
          <p className="mt-2 text-[12px] text-meta">Inferred from item titles only (no quantities or prices exist in the data), using the configurable keyword-to-minutes map. This is an operational-time estimate shown for context. It is never a dollar cost and does not affect the profitability figures above.{h.keywords.length > 0 ? ` Keywords matched: ${h.keywords.join(", ")}.` : " No heavier-handling keywords matched, so only the per-item baseline applies."}</p>
        </>
      )}
    </div>
  );
}

// ── Insights (FI Stage 7c) — deterministic facts first, AI interpretation clearly secondary + labeled ──
const INSIGHT_CATEGORY_LABEL: Record<InsightFact["category"], string> = {
  margin: "Margin",
  labor_grain: "Labor grain",
  category_margin: "Category",
  reconciliation_trend: "Reconciliation",
};

function InsightsView({ insights, href }: { insights: InsightsResult; href: (p: Partial<{ view: string; project: string }>) => string }): React.JSX.Element {
  const o = insights.overview;
  return (
    <section className="space-y-6">
      <div className="rounded border border-border bg-panel px-4 py-3 text-[12.5px] text-meta">
        Historical learning for <span className="text-foreground">{insights.periodLabel}</span>. The facts below are computed deterministically from this period&apos;s project snapshots and reconciliation history. The AI interpretation, when present, only reads those facts, it never adds a number.
      </div>

      {/* Deterministic overview tiles */}
      <section className="grid gap-px overflow-hidden border border-border bg-border md:grid-cols-3">
        <Block title="Margin" tag="computed" headline={o.avgMarginPct == null ? <Unavail /> : pct(o.avgMarginPct)}>
          <BRow label="Projects with margin">{o.marginProjectCount || "—"}</BRow>
          <BRow label={`Low margin (≤ ${pct(o.lowMarginPct)})`}>{o.marginProjectCount ? <span className={o.lowMarginCount ? "text-foreground" : undefined}>{o.lowMarginCount}</span> : "—"}</BRow>
        </Block>
        <Block title="Labor grain" tag="estimated vs actual" headline={o.laborProjectCount ? `${o.estimatedLaborCount}/${o.laborProjectCount}` : <Unavail />}>
          <BRow label="Estimated grain">{o.estimatedLaborCount}</BRow>
          <BRow label="Verified actual">{o.actualLaborCount}</BRow>
        </Block>
        <Block title="Categories" tag="by item keyword" headline={`${o.categories.length}`}>
          <BRow label="Tracked categories">{o.categories.length || "—"}</BRow>
          <BRow label="Below book">{o.categories.filter((c) => !c.thin && c.deltaVsOverallPct <= -0.05).length || "—"}</BRow>
        </Block>
      </section>

      {/* Deterministic facts (first-class) */}
      <div>
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Facts (computed)</h2>
        {insights.facts.length === 0 ? (
          <p className="text-[12.5px] text-meta">No facts could be computed for this period yet. This needs project snapshots with a known margin and some reconciliation history. It is empty, not zero.</p>
        ) : (
          <ul className="space-y-2">
            {insights.facts.map((f) => (
              <li key={f.id} className="flex items-start gap-3 border border-border bg-panel px-4 py-2.5 text-[12.5px]">
                <span className="mt-[1px] min-w-[96px] text-[11px] uppercase tracking-[0.06em] text-meta">{INSIGHT_CATEGORY_LABEL[f.category]}</span>
                <span className="flex-1">{f.text}{f.thin ? <span className="ml-2 text-[10px] uppercase tracking-[0.06em] text-meta">thin</span> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* AI interpretation (clearly secondary + labeled) */}
      <div>
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">AI interpretation <span className="ml-1 text-[11px] normal-case tracking-normal text-meta">reads the facts above, adds no numbers</span></h2>
        {insights.interpretation ? (
          <div className="border border-border bg-panel px-4 py-3">
            {insights.interpretation.summary && <p className="mb-3 text-[13px]">{insights.interpretation.summary}</p>}
            {insights.interpretation.recommendations.length > 0 && (
              <ul className="list-disc space-y-1.5 pl-5 text-[12.5px]">
                {insights.interpretation.recommendations.map((rec, i) => (
                  <li key={i}>{rec.text}{rec.basedOn ? <span className="ml-1 text-[10px] uppercase tracking-[0.06em] text-meta">({rec.basedOn})</span> : null}</li>
                ))}
              </ul>
            )}
            <p className="mt-3 border-t border-[var(--row-rule)] pt-2 text-[11.5px] text-meta">{insights.interpretationNote}{insights.interpretation.model ? ` · ${insights.interpretation.model}` : ""}</p>
          </div>
        ) : (
          <p className="text-[12.5px] text-meta">{insights.interpretationNote}</p>
        )}
      </div>

      <p className="text-[12px] text-meta"><Link href={href({ view: "projects" })} className="underline">See the projects behind these facts →</Link></p>
    </section>
  );
}

// ── Data lineage panel (per-number) ────────────────────────────────────────────────────────────────
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
          <table className={tableCls} style={{ minWidth: "720px" }}>
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
                  <td className="px-2.5 py-2 text-right tabular-nums text-foreground">{l.amount == null ? <span className="text-meta">unavail</span> : money(l.amount)}</td>
                  <td className="px-2.5 py-2"><span className="inline-flex items-center gap-2"><MethodTag method={l.method} confidence={l.confidence} /> <span className="text-[10px] uppercase text-meta">{l.amountStatus}</span></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// One labeled component row — null value renders "—" (unavailable), never a fabricated 0.
function RevRow({ label, value, sub, tone }: { label: string; value: number | null; sub?: string; tone?: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-[var(--row-rule)] px-3 py-2 first:border-t-0">
      <span className="text-[12.5px] text-tertiary-text">{label}{sub ? <span className="ml-1 text-[11px] text-meta">{sub}</span> : null}</span>
      <span className={`tabular-nums text-[13px] ${tone ?? "text-foreground"}`}>{value == null ? <span className="text-meta">—</span> : money(value)}</span>
    </div>
  );
}

// Stage 3 revenue-component breakdown. Reads straight off the deterministic model — every figure is a real
// dollar value or "—" (unavailable), never a fabricated 0. Invoiced is labeled as not-a-Goodshuffle-state.
function RevenueComponentsPanel({ c }: { c: RevenueComponents }): React.JSX.Element {
  const ratePct = c.effectiveTaxRate == null ? null : `${(c.effectiveTaxRate * 100).toFixed(2)}%`;
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Revenue components</h3>
      <div className="grid gap-px overflow-hidden border border-border bg-border md:grid-cols-2">
        <div className="bg-panel">
          <RevRow label="Quoted subtotal" value={c.quotedSubtotal} sub="pre-discount" />
          <RevRow label="Product" value={c.productSubtotal} />
          <RevRow label="Service" value={c.serviceSubtotal} />
          <RevRow label="Delivery (logistics)" value={c.logisticsSubtotal} />
          <RevRow label="Discounts" value={c.discountsTotal} tone={c.discountsTotal ? "text-attention" : undefined} />
          <RevRow label="Taxable subtotal" value={c.taxableSubtotal} />
          <RevRow label="Tax" value={c.taxTotal} sub={ratePct ?? undefined} />
          <RevRow label="Contracted total" value={c.grandTotal} tone="text-foreground font-medium" />
        </div>
        <div className="bg-panel">
          <RevRow label="Collected" value={c.collected} />
          <RevRow label="Refunds" value={c.refunds} tone={c.refunds ? "text-attention" : undefined} />
          <RevRow label="Net collected" value={c.netCollected} tone="text-foreground font-medium" sub="collected − refunds" />
          <RevRow label="Processing fees" value={c.processingFees} />
          <RevRow label="Goodshuffle fees" value={c.goodshuffleFees} />
          <RevRow label="Fees total" value={c.feesTotal} sub="cost to Zoe" />
          <div className="flex items-baseline justify-between gap-3 border-t border-[var(--row-rule)] px-3 py-2">
            <span className="text-[12.5px] text-tertiary-text">Invoiced</span>
            <span className="text-[11px] uppercase tracking-[0.06em] text-meta">not a Goodshuffle state</span>
          </div>
        </div>
      </div>
    </section>
  );
}
