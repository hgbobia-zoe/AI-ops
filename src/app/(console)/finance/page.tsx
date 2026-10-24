// Financial Intelligence — Nocturne. Operational control, not accounting: "ahead or behind plan?
// revenue or labor?" Every number is deterministic or explicitly UNAVAILABLE (never invented, never a
// zeroed cost, never an estimate shown as an actual). FI-Phase 1–5: the labor ledger now carries the
// internal/temp split, non-customer buckets (travel/warehouse/unallocated), the measured Instawork
// premium, three reconciling period dimensions (week / operational cycle / project), a route bridge
// level, the reconciliation view, and per-number data lineage.

import Link from "next/link";
import { financeForPeriod, projectFinancials } from "@/lib/finance/service";
import type { ProjectSnapshot } from "@/lib/finance/projectSnapshot";
import type { RevenueComponents } from "@/lib/finance/revenueModel";
import { getPeriod, PERIOD_KEYS, priorWeek, priorCycle, customRange, priorRange, type Period, type PeriodKey } from "@/lib/finance/periods";
import { opsCycleConfig } from "@/lib/finance/config";
import { getRouteLaborCosts, getInstaworkLedger, getLaborReconciliation, getProjectLaborLineage, getLaborLedgerSummary, getVisitReconciliation, getReconciliationRuns, getRecentReconciliationRuns, type ReconciliationRunRow } from "@/lib/db/repo";
import type { RunPhase, VarianceReason } from "@/lib/finance/reconciliationRun";
import { reconcileVisit, type VisitWindow } from "@/lib/finance/visitReconcile";
import { visitReconcileConfig } from "@/lib/finance/config";
import { formatClockTime } from "@/lib/dates";
import { listFinanceSavedViews } from "@/lib/finance/savedViews";
import type { Variance } from "@/lib/finance/calc";
import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";
import { BladeAgents } from "@/components/aiorg/BladeAgents";
import { FinanceDateRange } from "./FinanceDateRange";
import { FinanceSavedViews } from "./FinanceSavedViews";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { ManualCostEntry } from "./ManualCostEntry";

export const dynamic = "force-dynamic";

const money = (n: number | null | undefined): string => (n == null ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US"));
const hrs = (n: number | null): string => (n == null ? "—" : `${n} h`);
const pct = (n: number | null): string => (n == null ? "—" : `${Math.round(n * 100)}%`);

const VIEWS = ["overview", "week", "cycle", "routes", "projects", "labor", "instawork", "variance", "reconciliation", "visits"] as const;
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
  visits: "Visits (GPS vs dispatch)",
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

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ period?: string; view?: string; lineage?: string; project?: string; start?: string; end?: string }> }): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const cycle = opsCycleConfig();
  const key: PeriodKey = (PERIOD_KEYS as string[]).includes(sp?.period ?? "") ? (sp!.period as PeriodKey) : "thisWeek";
  const view: ViewKey = (VIEWS as readonly string[]).includes(sp?.view ?? "") ? (sp!.view as ViewKey) : "overview";
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
  const canEditCost = canSeeFinancials(await viewerRole()); // owner/admin may add/edit/delete manual costs

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

      <BladeAgents blade="finance" className="mb-5" />

      {/* Period presets (dimension A week + dimension B operational cycle + month) + custom range + saved views */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border pb-2">
        <nav className="flex flex-wrap items-center gap-4">
          {PERIOD_KEYS.map((k) => {
            const active = !customActive && k === key;
            return (
              <Link key={k} href={href({ period: k })} className={`text-[13.5px] transition-colors ${active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
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
        <p className="mb-3 text-[12.5px] text-attention">That date range wasn&apos;t valid (check the order and bounds), so {getPeriod(key, undefined, cycle).label} is shown instead.</p>
      )}

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

      {selectedProject ? (
        <ProjectDetail snap={projectSnap} id={selectedProject} runs={projectRuns} backHref={href({ view: "projects", project: undefined })} canEdit={canEditCost} />
      ) : (
        <>
          {(view === "overview" || view === "week" || view === "cycle") && <Overview s={s} L={L} tempHourShare={tempHourShare} href={href} />}
          {view === "routes" && <Routes rows={getRouteLaborCosts(period.start, period.end)} href={href} />}
          {view === "projects" && <ProjectsTable events={s.events} href={href} />}
          {view === "labor" && <LaborView L={L} s={s} tempHourShare={tempHourShare} />}
          {view === "instawork" && <InstaworkView rows={getInstaworkLedger(period.start, period.end)} L={L} />}
          {view === "variance" && <VarianceView s={s} L={L} priorCost={priorLaborCost(period, cycle)} />}
          {view === "reconciliation" && <Reconciliation rows={getLaborReconciliation(period.start, period.end)} runs={getRecentReconciliationRuns(period.start, period.end)} href={href} />}
          {view === "visits" && <VisitReconciliationView rows={getVisitReconciliation(period.start, period.end)} />}

          {sp?.lineage && <Lineage eventId={sp.lineage} label={s.events.find((e) => e.eventId === sp.lineage)?.label ?? sp.lineage} />}
        </>
      )}
    </main>
  );
}

function priorLaborCost(period: Period, cycle: ReturnType<typeof opsCycleConfig>): { label: string; cost: number | null } {
  // Custom range → the equal-length preceding window; cycle → prior cycle; else the prior Mon–Sun week.
  const prior = period.key === "custom" ? priorRange(period) : period.isCycle ? priorCycle(period, cycle) : priorWeek(period);
  return { label: prior.label, cost: getLaborLedgerSummary(prior.start, prior.end).totalCost };
}

// ── Overview (3 blocks + labor-ledger block + events) ──────────────────────────────────────────────
function Overview({ s, L, tempHourShare, href }: { s: Awaited<ReturnType<typeof financeForPeriod>>; L: Awaited<ReturnType<typeof financeForPeriod>>["laborLedger"]; tempHourShare: number | null; href: (p: Partial<{ view: string; lineage: string; project: string }>) => string }): React.JSX.Element {
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
function ProjectsTable({ events, href }: { events: Awaited<ReturnType<typeof financeForPeriod>>["events"]; href: (p: Partial<{ view: string; lineage: string; project: string }>) => string }): React.JSX.Element {
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
                <td className="px-2.5 py-2.5"><Link href={href({ view: "projects", project: e.eventId })} className="hover:underline">{e.label || `Project ${e.eventId}`}</Link></td>
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
      <p className="mt-3 text-[12px] text-meta">Project labor is attributed from the labor ledger down worker → route → stop → project. Today it is planned-grain (method PLANNED/Derived), labeled — never a fake ACTUAL. A project carries labor for BOTH its delivery and pickup visits (real labor, not double-counted). Click a project for its full profitability snapshot and data lineage.</p>
    </>
  );
}

// ── Per-project profitability snapshot (compute-on-read) ───────────────────────────────────────────
const SNAP_STATUS_TONE: Record<ProjectSnapshot["status"], string> = {
  RECONCILED: "text-positive",
  ESTIMATED: "text-foreground",
  PROVISIONAL: "text-attention",
};
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

function StatusBadge({ status }: { status: ProjectSnapshot["status"] }): React.JSX.Element {
  return <span className={`text-[11px] font-medium uppercase tracking-[0.08em] ${SNAP_STATUS_TONE[status]}`}>{status}</span>;
}

// ── Reconciliation-run lifecycle (Stage 7a) labels ──────────────────────────────────────────────────
const PHASE_TONE: Record<RunPhase, string> = {
  snapshot: "text-muted-foreground",
  revision: "text-attention",
  final: "text-positive",
};
const PHASE_LABEL: Record<RunPhase, string> = { snapshot: "Snapshot", revision: "Revision", final: "Final" };
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

function PhaseBadge({ phase }: { phase: RunPhase }): React.JSX.Element {
  return <span className={`text-[11px] font-medium uppercase tracking-[0.08em] ${PHASE_TONE[phase]}`}>{PHASE_LABEL[phase]}</span>;
}

function signedMoney(n: number): string {
  return (n > 0 ? "+" : n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
}

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
              <PhaseBadge phase={run.phase} />
              <StatusBadge status={run.status} />
              <span className="text-meta">{run.capturedAt.slice(0, 16).replace("T", " ")}</span>
              <span className="ml-auto flex flex-wrap items-center gap-x-4 tabular-nums">
                <span className="text-meta">Rev <span className="text-foreground">{money(run.revenue)}</span></span>
                <span className="text-meta">Cost <span className="text-foreground">{money(run.directCost)}</span></span>
                <span className="text-meta">Contrib <span className={run.contribution == null ? "text-foreground" : run.contribution >= 0 ? "text-positive" : "text-critical"}>{money(run.contribution)}</span></span>
                {!run.balanced && <span className="text-critical">UNBALANCED</span>}
              </span>
            </div>
            {run.variance && run.variance.lines.length > 0 ? (
              <ul className="mt-2 space-y-1 border-t border-[var(--row-rule)] pt-2 text-[12px]">
                {run.variance.lines.map((ln) => (
                  <li key={ln.line} className="flex flex-wrap items-center gap-x-3">
                    <span className="min-w-[150px] text-meta">{ln.label}</span>
                    <span className="tabular-nums text-tertiary-text">{money(ln.prior)} → {money(ln.current)}</span>
                    <span className={`tabular-nums ${ln.delta > 0 ? "text-positive" : ln.delta < 0 ? "text-critical" : "text-meta"}`}>{signedMoney(ln.delta)}</span>
                    <span className="text-[11px] uppercase tracking-[0.06em] text-attention">{REASON_LABEL[ln.reason]}</span>
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

function ProjectDetail({ snap, id, runs, backHref, canEdit }: { snap: ProjectSnapshot | null; id: string; runs: ReconciliationRunRow[]; backHref: string; canEdit: boolean }): React.JSX.Element {
  if (!snap) {
    return (
      <section>
        <p className="mb-3 text-[12.5px]"><Link href={backHref} className="text-muted-foreground underline hover:text-foreground">← Back to projects</Link></p>
        <p className="text-[13.5px] text-muted-foreground">Project <span className="font-mono">{id}</span> isn&apos;t in the bookings pull yet, so no profitability snapshot can be computed. It is not zero — it is unavailable until the next Goodshuffle pull.</p>
      </section>
    );
  }
  const r = snap.revenue;
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="mb-1 text-[12.5px]"><Link href={backHref} className="text-muted-foreground underline hover:text-foreground">← Back to projects</Link></p>
          <h2 className="text-[17px] font-medium tracking-tight">{snap.label}</h2>
          <p className="text-[12px] text-meta">Project <span className="font-mono">{snap.projectId}</span>{snap.eventDate ? ` · ${snap.eventDate}` : ""} · <StatusBadge status={snap.status} /></p>
        </div>
      </div>

      {/* Headline economics */}
      <section className="mb-6 grid gap-px overflow-hidden border border-border bg-border md:grid-cols-3">
        <Block title="Revenue" tag={r.contractedStatus.toLowerCase()} headline={r.contracted == null ? <Unavail /> : money(r.contracted)}>
          <BRow label="Subtotal (pre-discount)">{r.subtotal == null ? <Unavail /> : money(r.subtotal)}</BRow>
          <BRow label="Collected">{r.collected == null ? <Unavail /> : money(r.collected)}</BRow>
          <BRow label="Due">{r.due == null ? <Unavail /> : money(r.due)}</BRow>
          <BRow label="Signed">{r.signed ? "Yes" : <span className="text-attention">Quote (unsigned)</span>}</BRow>
        </Block>
        <Block title="Direct cost" tag={snap.directCostStatus.toLowerCase()} headline={snap.directCost == null ? <Unavail /> : money(snap.directCost)}>
          {snap.costFamilies.filter((f) => f.tracked).map((f) => (
            <BRow key={f.type} label={COST_FAMILY_LABEL[f.type] ?? f.type}>{money(f.amount)}{f.status === "ESTIMATED" ? <span className="ml-1 text-[10px] uppercase text-meta">est</span> : null}</BRow>
          ))}
          {snap.costFamilies.every((f) => !f.tracked) && <BRow label="Tracked families"><span className="text-meta">None yet</span></BRow>}
        </Block>
        <Block title="Contribution" tag={snap.contributionStatus.toLowerCase()} headline={snap.contribution == null ? <Unavail /> : <span className={snap.contribution >= 0 ? "text-positive" : "text-critical"}>{money(snap.contribution)}</span>}>
          <BRow label="Margin">{snap.marginPct == null ? <Unavail /> : pct(snap.marginPct)}</BRow>
          <BRow label="Basis">{snap.contribution == null ? <span className="text-meta">needs revenue + cost</span> : <span className="text-meta">revenue − direct cost</span>}</BRow>
        </Block>
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
        <table className={tableCls}>
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
                <td className="px-2.5 py-2.5 text-right tabular-nums">{f.amount == null ? <span className="text-meta">unavailable</span> : money(f.amount)}</td>
                <td className="px-2.5 py-2.5">{f.tracked ? <span className="text-[11px] uppercase tracking-[0.06em] text-meta">{f.status.toLowerCase()}</span> : <span className="text-[11px] uppercase tracking-[0.06em] text-meta">not tracked</span>}</td>
                <td className="px-2.5 py-2.5"><MethodBadge method={f.method} confidence={f.confidence} /></td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{f.leafCount || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Reconciliation — the family parts sum back to the direct-cost total */}
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 border border-border bg-panel px-4 py-3 text-[12.5px]">
        <span className="text-meta">Reconciliation</span>
        <span>Family sum <span className="tabular-nums">{money(snap.reconciliation.familySum)}</span></span>
        <span>Direct cost <span className="tabular-nums">{money(snap.reconciliation.directCostTotal)}</span></span>
        <span>Residual <span className="tabular-nums">{snap.reconciliation.residual == null ? "—" : money(snap.reconciliation.residual)}</span></span>
        <span className={snap.reconciliation.balanced ? "text-positive" : "text-critical"}>{snap.reconciliation.balanced ? "Balanced" : "UNBALANCED"}</span>
      </div>

      {/* Honest gaps */}
      <div className="mt-4">
        <h3 className="mb-1 text-[12px] font-medium uppercase tracking-[0.1em] text-tertiary-text">How to read this</h3>
        <p className="mb-2 text-[12.5px] text-meta">{snap.statusReason}{snap.revenueAsOf ? ` · revenue as of ${snap.revenueAsOf.slice(0, 16).replace("T", " ")}` : ""}</p>
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
              <table className={tableCls}>
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
                        <td className="px-2.5 py-2.5"><PhaseBadge phase={run.phase} /></td>
                        <td className="px-2.5 py-2.5"><StatusBadge status={run.status} /></td>
                        <td className="px-2.5 py-2.5 text-right tabular-nums text-tertiary-text">{run.seq}</td>
                        <td className="px-2.5 py-2.5 text-right tabular-nums">{money(run.revenue)}</td>
                        <td className="px-2.5 py-2.5 text-right tabular-nums">{money(run.directCost)}</td>
                        <td className="px-2.5 py-2.5 text-right tabular-nums">{run.contribution == null ? <span className="text-meta">—</span> : <span className={run.contribution >= 0 ? "text-positive" : "text-critical"}>{money(run.contribution)}</span>}</td>
                        <td className="px-2.5 py-2.5 text-[11.5px]">{topLine ? <span><span className="text-attention uppercase tracking-[0.06em]">{REASON_LABEL[topLine.reason]}</span> <span className="tabular-nums text-meta">{signedMoney(topLine.delta)}</span></span> : <span className="text-meta">baseline</span>}</td>
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
      </div>
      )}
    </section>
  );
}

// ── Visit reconciliation (GPS vs dispatch) view (FI Stage 4) ───────────────────────────────────────
const VISIT_LABEL_TONE: Record<string, string> = {
  GPS_DISPATCH: "text-positive",
  GPS_CONFIRMED: "text-positive",
  DISPATCH_FLAGGED: "text-critical",
  DISPATCH_ONLY: "text-attention",
  NONE: "text-meta",
};
const VISIT_LABEL_TEXT: Record<string, string> = {
  GPS_DISPATCH: "GPS + dispatch",
  GPS_CONFIRMED: "GPS only",
  DISPATCH_FLAGGED: "Flagged",
  DISPATCH_ONLY: "Dispatch only",
  NONE: "No evidence",
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
            <span className="text-meta">Flagged for review <span className={`tabular-nums ${flagged ? "text-critical" : "text-foreground"}`}>{flagged}</span></span>
          </div>
          <div className="overflow-x-auto border border-border">
            <table className={tableCls}>
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
                    <td className="px-2.5 py-2.5"><span className={`text-[11px] uppercase tracking-[0.06em] ${VISIT_LABEL_TONE[v.label] ?? "text-meta"}`}>{VISIT_LABEL_TEXT[v.label] ?? v.label}</span></td>
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

// One labeled component row — null value renders "—" (unavailable), never a fabricated 0.
function RevRow({ label, value, sub, tone }: { label: string; value: number | null; sub?: string; tone?: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-[var(--row-rule)] px-3 py-2 first:border-t-0">
      <span className="text-[12.5px] text-tertiary-text">{label}{sub ? <span className="ml-1 text-[11px] text-meta">{sub}</span> : null}</span>
      <span className={`tabular-nums text-[13px] ${tone ?? ""}`}>{value == null ? <span className="text-meta">—</span> : money(value)}</span>
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
