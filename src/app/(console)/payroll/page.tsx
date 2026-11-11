// HR / Payroll — the Zoe Payroll Control Plane. Reconciliation + control layer between Connecteam (operational
// time source of truth) and Gusto (payroll system of record). The blade's eight sections are NESTED VERTICAL
// links in the global sidebar (ConsoleNav → People › Payroll › Overview · Payroll Review · Time Sync · Workers
// · Contractors · Exceptions · History · Settings); there is NO in-page nav rail and NO horizontal tab row,
// so the page uses the full recovered width. Sections are the SAME ?tab= URLs (deep-linkable, period-preserving).
//
// ONE authoritative readiness model (lib/payroll/readinessModel.ts) drives every status, count, badge and
// action on Overview + Review, so the two can never disagree for the same period/snapshot. FACTS ONLY — an
// unknown renders as "—"/"unknown", never a fabricated number. Owner/admin only (canManagePayroll + proxy).

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Wallet, Users, UserCheck, History,
  ArrowRight, ChevronLeft, ChevronRight, CheckCircle2, Clock,
  ClipboardCheck, CalendarClock,
} from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canManagePayroll, canRunPayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { connecteamConfigured, getTimesheetReview } from "@/lib/connecteam";
import { completedWeeksBack } from "@/lib/payroll/period";
import { clampWeeksAgo, periodNavHref } from "@/lib/payroll/nav";
import { derivePayrollReadiness, payrollApprovability } from "@/lib/payroll/readinessModel";
import { unifiedWorkers } from "@/lib/payroll/workers";
import { payrollReview } from "@/lib/payroll/review";
import { listExceptions, listSyncRuns, countTimeEntries } from "@/lib/payroll/store";
import { gustoConfigured } from "@/lib/payroll/gusto";
import { instaworkTempPay } from "@/lib/payroll/instawork";
import {
  WORKER_TYPE_LABEL,
  type UnifiedWorker, type ExceptionSeverity,
  type UnifiedWorkerRow,
} from "@/lib/payroll/types";
import { getPayrollConfig } from "@/lib/payroll/config";
import { readGustoSnapshot } from "@/lib/payroll/gustoSnapshot";
import { getLatestImportBySource } from "@/lib/pull/state";
import { WorkerEditor, type GustoPick } from "@/components/payroll/WorkerEditor";
import { SyncButton } from "@/components/payroll/SyncButton";
import { SyncGustoButton } from "@/components/payroll/SyncGustoButton";
import { ContractorPayPanel } from "@/components/payroll/ContractorPayPanel";
import { gustoPushDisabled, readGustoPushResult } from "@/lib/payroll/gustoPushState";
import { RunPayrollFlow } from "@/components/payroll/RunPayrollFlow";
import { ConfirmWireButton } from "@/components/payroll/ConfirmWireButton";
import { confirmWireGate, expectedCheckDate } from "@/lib/payroll/gustoSubmit";
import { gustoSubmitDisabled, readGustoSubmitResult, readGustoConfirmWireResult, periodKey } from "@/lib/payroll/gustoSubmitState";
import { listWireEvents } from "@/lib/payroll/wireEvent";
import { ApproveButton } from "@/components/payroll/ApproveButton";
import { PayrollSettingsForm } from "@/components/payroll/PayrollSettingsForm";
import { ExceptionActions } from "@/components/payroll/ExceptionActions";
import { RateSyncPanel } from "@/components/payroll/RateSyncPanel";
import { PayrollReviewBoard, type ReviewRow, type ReviewTimesheet } from "@/components/payroll/PayrollReviewBoard";
import { buildRateSyncPlan } from "@/lib/payroll/rateSync";
import { runReadiness } from "@/lib/payroll/runReadiness";
import { buildOverviewView, type OverviewLedgers } from "@/lib/payroll/overviewView";
import { PayrollOverview } from "@/components/payroll/PayrollOverview";
import { StatusBadge } from "@/components/ui/status";
import { Fragment } from "react";

export const dynamic = "force-dynamic";

type Tab = "overview" | "review" | "sync" | "workers" | "contractors" | "exceptions" | "history" | "settings";
const TAB_KEYS: Tab[] = ["overview", "review", "sync", "workers", "contractors", "exceptions", "history", "settings"];
const TAB_TITLE: Record<Tab, string> = {
  overview: "Payroll Overview", review: "Payroll Review", sync: "Time Sync", workers: "Employees",
  contractors: "Contractors", exceptions: "Exceptions", history: "History", settings: "Settings",
};

// ── formatting ───────────────────────────────────────────────────────────────────────────────────────
const money = (n: number | null, cur = "USD"): string => {
  if (n == null) return "—";
  const sym = cur === "EUR" ? "€" : cur === "GBP" ? "£" : "$";
  return sym + Math.round(n).toLocaleString("en-US");
};
const hrs = (n: number | null): string => (n == null ? "—" : `${n.toLocaleString("en-US")} h`);
function relTime(iso: string | null): string {
  if (!iso) return "never";
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "—";
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function periodYear(p: { start: string; end: string }): string {
  const ys = p.start.slice(0, 4), ye = p.end.slice(0, 4);
  return ys === ye ? ys : `${ys}–${ye}`;
}


export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; weeksAgo?: string; status?: string; q?: string }>;
}): Promise<React.JSX.Element> {
  if (!canManagePayroll(await viewerRole())) redirect("/");
  const sp = await searchParams;
  const tab: Tab = (TAB_KEYS.includes(sp.tab as Tab) ? sp.tab : "overview") as Tab;
  // Payroll is ALWAYS run for a COMPLETED week (Tuesday, for the week that just ended). Default = last completed
  // week; `weeksAgo` (1–8) steps further back through completed weeks. (`?period=previous` legacy = weeksAgo 1.)
  const weeksAgo = clampWeeksAgo(sp.weeksAgo);

  const today = await safeToday();
  const period = completedWeeksBack(today, weeksAgo);

  // The eight sections are nested in the GLOBAL sidebar (ConsoleNav → People › Payroll). There is no
  // in-page nav rail and no horizontal tab row — the page uses the full recovered width.
  return (
    <main className="mx-auto w-full min-w-0 max-w-[1440px] p-4 pb-12 leading-[1.35] md:p-6 lg:px-8">
      <PayrollHeader tab={tab} period={period} weeksAgo={weeksAgo} />
      {tab === "overview" && <OverviewTab period={period} weeksAgo={weeksAgo} />}
      {tab === "review" && <ReviewTab period={period} weeksAgo={weeksAgo} />}
      {tab === "sync" && <SyncTab period={period} weeksAgo={weeksAgo} />}
      {tab === "workers" && <WorkersTab period={period} mode="all" />}
      {tab === "contractors" && (
        <div className="space-y-4">
          <ContractorPayPanel />
          <WorkersTab period={period} mode="contractors" />
        </div>
      )}
      {tab === "exceptions" && <ExceptionsTab />}
      {tab === "history" && <HistoryTab />}
      {tab === "settings" && <SettingsTab />}
    </main>
  );
}

async function safeToday(): Promise<string> {
  try {
    return (await commandCenter()).today;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ── Shared header: breadcrumb · title · period selector · deadline · last-sync + sync ───────────────────
function PayrollHeader({ tab, period, weeksAgo }: { tab: Tab; period: { start: string; end: string; label: string }; weeksAgo: number }): React.JSX.Element {
  const cfg = getPayrollConfig();
  const last = listSyncRuns(1)[0] ?? null;
  const hrefFor = (n: number): string => periodNavHref(tab, n);
  const olderN = Math.min(8, weeksAgo + 1);
  const newerN = Math.max(1, weeksAgo - 1);
  const atNewest = weeksAgo <= 1;
  const atOldest = weeksAgo >= 8;
  return (
    <header className="mb-5 border-b border-border pb-4">
      {/* The breadcrumb (People › Payroll › <section>) lives once in the global app header, not here. */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-foreground">
            <Wallet className="size-5 text-meta" aria-hidden /> {TAB_TITLE[tab]}
          </h1>
          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-meta">
            <span className="inline-flex items-center gap-1">Connecteam</span>
            <ArrowRight className="size-3" aria-hidden /> <span>Zoe reconcile</span>
            <ArrowRight className="size-3" aria-hidden /> <span>Gusto</span>
          </p>
        </div>

        {/* Pay-period selector — completed weeks only; prev = older, next = newer. Deep-linkable. */}
        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          <div className="flex items-center gap-1.5">
            <PagerLink href={hrefFor(olderN)} disabled={atOldest} label="Older period" dir="left" />
            <div className="min-w-[164px] rounded-md border border-border bg-[var(--panel)] px-3 py-1.5 text-center">
              <div className="text-[13px] font-medium tabular-nums text-foreground">{period.label}, {periodYear(period)}</div>
              <div className="text-[10.5px] text-meta">{weeksAgo === 1 ? "Last completed week" : `${weeksAgo} weeks ago`}</div>
            </div>
            <PagerLink href={hrefFor(newerN)} disabled={atNewest} label="Newer period" dir="right" />
          </div>
          <details className="group text-[11px]">
            <summary className="cursor-pointer list-none text-meta transition-colors hover:text-foreground">History ▾</summary>
            <div className="mt-1 flex flex-wrap gap-1">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <Link key={n} href={hrefFor(n)}
                  className={`rounded px-2 py-0.5 text-[11px] transition-colors ${weeksAgo === n ? "bg-foreground/[0.08] text-foreground" : "text-meta hover:text-foreground"}`}>
                  {n === 1 ? "Last week" : `${n}w ago`}
                </Link>
              ))}
            </div>
          </details>
        </div>
      </div>

      {/* Deadline + last-verified + a secondary sync (dedupe + progress handled by SyncButton) */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11.5px] text-meta">
        <span className="inline-flex items-center gap-1.5"><CalendarClock className="size-3.5" aria-hidden /> {tab === "overview" ? "Recurring run: " : "Payroll runs "}{payrollDeadlineText(cfg)}</span>
        {tab !== "overview" && <span className="inline-flex items-center gap-1.5"><Clock className="size-3.5" aria-hidden /> Hours last verified {relTime(last?.finishedAt ?? last?.startedAt ?? null)}{last ? ` · ${last.status.toLowerCase().replace(/_/g, " ")}` : ""}</span>}
        {/* One Sync control per view (never two "Sync hours" doing the same thing): Overview's readiness banner
            and the Time Sync tab each already own a primary sync, so the header sync is shown on the rest only. */}
        {tab !== "overview" && tab !== "sync" && <span className="ml-auto"><SyncButton period={period} label="Sync hours" variant="secondary" /></span>}
      </div>
    </header>
  );
}

function payrollDeadlineText(cfg: ReturnType<typeof getPayrollConfig>): string {
  const DOW = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  const h = cfg.payrollHour;
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${DOW[cfg.payrollDay]} ${hr}:00 ${ampm} ET`;
}

function PagerLink({ href, disabled, label, dir }: { href: string; disabled: boolean; label: string; dir: "left" | "right" }): React.JSX.Element {
  const Icon = dir === "left" ? ChevronLeft : ChevronRight;
  if (disabled) {
    return <span aria-disabled className="flex size-8 items-center justify-center rounded-md border border-border text-[color:var(--bar)] opacity-40"><Icon className="size-4" aria-hidden /></span>;
  }
  return (
    <Link href={href} aria-label={label} className="flex size-8 items-center justify-center rounded-md border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
      <Icon className="size-4" aria-hidden />
    </Link>
  );
}

// ══ OVERVIEW ════════════════════════════════════════════════════════════════════════════════════════════
// Can this period proceed, what to do next, and what happened on the latest attempt. The view is built from the
// same readiness model as Payroll Review (buildOverviewView → runReadiness), plus the sync and Gusto ledgers.
async function OverviewTab({ period, weeksAgo }: { period: { start: string; end: string; label: string }; weeksAgo: number }): Promise<React.JSX.Element> {
  const m = await derivePayrollReadiness(period);
  const periodQS = weeksAgo > 1 ? `&weeksAgo=${weeksAgo}` : "";
  const runs = listSyncRuns(20);
  const lastRun = runs.find((r) => r.periodStart === period.start && r.periodEnd === period.end) ?? runs[0] ?? null;
  const push = readGustoPushResult();
  const submit = readGustoSubmitResult(periodKey(period.start, period.end));
  const ledgers: OverviewLedgers = {
    lastSync: lastRun ? { status: lastRun.status, at: lastRun.finishedAt ?? lastRun.startedAt, periodStart: lastRun.periodStart, periodEnd: lastRun.periodEnd, reviewCount: lastRun.reviewCount } : null,
    lastPush: push ? { at: push.at, ok: push.ok, aborted: push.aborted, pushed: push.pushed, failed: push.failed, skipped: push.skipped, periodStart: push.periodStart, periodEnd: push.periodEnd } : null,
    lastSubmit: submit ? { at: submit.at, ok: submit.ok, aborted: submit.aborted, submitted: submit.submitted, alreadySubmitted: submit.alreadySubmitted, errors: submit.errors } : null,
  };
  const view = buildOverviewView(m, ledgers, periodQS);
  return <PayrollOverview view={view} period={m.period} gates={m.gates} sources={m.sources} schedule={m.schedule} activity={m.activity} />;
}

// ══ PAYROLL REVIEW ══════════════════════════════════════════════════════════════════════════════════════
// The review screen answers three questions fast: who is paid, what hours and estimated gross go through, and
// what must be resolved first. Compact run summary + actions, then the worker table (PayrollReviewBoard: one
// row per worker, full-run totals, Connecteam day detail in a side panel), then the rate check, folded away.
async function ReviewTab({ period, weeksAgo }: {
  period: { start: string; end: string; label: string }; weeksAgo: number;
}): Promise<React.JSX.Element> {
  const [m, ratePlan, tsReview] = await Promise.all([
    derivePayrollReadiness(period), buildRateSyncPlan(period.end), getTimesheetReview(period.start, period.end),
  ]);
  if (m.status === "NO_DATA" || (m.counts.included === 0 && m.counts.excluded === 0)) {
    return <EmptyState icon={<ClipboardCheck className="size-5" />} title="Nothing to review yet" body="No worker hours for this period (or Connecteam is unavailable). Sync hours, then review." />;
  }
  const appr = payrollApprovability(m, false);
  const approvable = new Set([...appr.readyKeys, ...appr.acknowledgeableKeys]);
  const gustoMembers: GustoPick[] = (readGustoSnapshot()?.members ?? []).map((gm) => ({
    id: gm.id, name: gm.preferredName || `${gm.firstName} ${gm.lastName}`.trim() || gm.id, personType: gm.personType, country: gm.country,
  }));
  const timesheetOf = (w: UnifiedWorkerRow): ReviewTimesheet | null => {
    const t = w.connecteamUserId != null ? tsReview.byUser.get(w.connecteamUserId) : undefined;
    return t ? { totalHours: t.totalHours, approvalState: t.approvalState, openPunch: t.openPunch, days: t.days } : null;
  };
  const rows: ReviewRow[] = [
    ...m.workers.map((w) => ({ ...w, excluded: false, approvable: approvable.has(w.key), timesheet: timesheetOf(w) })),
    ...m.excludedWorkers.map((w) => ({ ...w, excluded: true, approvable: false, timesheet: timesheetOf(w) })),
  ];

  // Run summary (always the full run).
  // The run-level line is the shared runReadiness() — Overview shows the exact same result.
  const readiness = runReadiness(m);
  const contractors = readiness.contractors;
  const totalHours = m.workers.reduce((s, w) => s + (w.hours ?? 0), 0);
  const payrollApproved = m.approval?.status === "APPROVED";

  // Run payroll + wire confirm (last completed week only; the submit itself is admin-only).
  const pushDisabled = gustoPushDisabled();
  const lastPush = readGustoPushResult();
  const canPushPeriod = weeksAgo === 1;
  const role = await viewerRole();
  const canRun = canRunPayroll(role);
  const submitDisabled = gustoSubmitDisabled();
  const subKey = periodKey(period.start, period.end);
  const lastSubmit = readGustoSubmitResult(subKey);
  const lastConfirm = readGustoConfirmWireResult(subKey);
  const confirmGate = confirmWireGate(
    lastSubmit ? { ok: lastSubmit.ok, submitted: lastSubmit.submitted } : null,
    lastConfirm ? { ok: lastConfirm.ok, confirmed: lastConfirm.confirmed } : null,
  );
  const wireCheckDate = expectedCheckDate(period.end, getPayrollConfig().payrollDay);
  const wireEvent = listWireEvents(50).find(
    (w) => w.matchedPeriod?.periodStart === period.start && w.matchedPeriod?.periodEnd === period.end,
  ) ?? null;
  const wireAmount = wireEvent?.amountAbs ?? lastSubmit?.expectedTotal ?? m.totals.estGross ?? null;
  const wireDate = (wireEvent?.createdAt ? wireEvent.createdAt.slice(0, 10) : null) ?? new Date().toISOString().slice(0, 10);
  const approvedCount = m.workers.filter((w) => w.approvalState === "APPROVED_IN_ZOE").length;
  const rc = m.rateComparison;

  return (
    <div className="flex flex-col gap-4">
      <section className="surface flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <SummaryFigure label="In run" value={String(m.counts.included)} />
            <SummaryFigure label="Payable hours" value={totalHours.toFixed(2)} />
            <SummaryFigure label="Est. gross" value={m.totals.estGross == null ? "—" : `$${m.totals.estGross.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[12px]">
            <StatusBadge tone={readiness.tone} size="sm">{readiness.label}</StatusBadge>
            <span className="text-secondary-text">{readiness.text}</span>
          </div>
          {contractors > 0 && <p className="mt-1 text-[11px] text-meta">{contractors} contractor{contractors === 1 ? " is" : "s are"} paid separately through Gusto contractor payments.</p>}
        </div>
        <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
          {!canPushPeriod ? (
            <>
              <ApproveButton period={period} readyCount={appr.readyKeys.length} acknowledgeableCount={appr.acknowledgeableKeys.length} ackReason={appr.ackReason} approved={payrollApproved} approvedCount={approvedCount} />
              <span className="max-w-[16rem] text-right text-[11px] text-meta">Run payroll works on the last completed week, the one in the Gusto draft.</span>
            </>
          ) : lastConfirm?.ok && lastConfirm.confirmed ? (
            <span className="max-w-[16rem] text-right text-[11px] text-positive">Payroll submitted and the wire is confirmed in Gusto for this period.</span>
          ) : confirmGate.canConfirm ? (
            canRun ? (
              <ConfirmWireButton
                period={period}
                checkDate={wireCheckDate}
                amount={wireAmount}
                wireDate={wireDate}
                lastConfirm={lastConfirm ? { at: lastConfirm.at, ok: lastConfirm.ok, confirmed: lastConfirm.confirmed, aborted: lastConfirm.aborted } : null}
              />
            ) : (
              <span className="max-w-[16rem] text-right text-[11px] text-positive">Payroll submitted. An administrator confirms the wire.</span>
            )
          ) : (
            <>
              <RunPayrollFlow
                period={period}
                readyCount={appr.readyKeys.length}
                acknowledgeableCount={appr.acknowledgeableKeys.length}
                ackReason={appr.ackReason}
                approved={payrollApproved}
                canRun={canRun}
                pushDisabled={pushDisabled}
                submitDisabled={submitDisabled}
                lastPush={lastPush ? { at: lastPush.at, ok: lastPush.ok, aborted: lastPush.aborted, pushed: lastPush.pushed } : null}
                lastSubmit={lastSubmit ? { at: lastSubmit.at, ok: lastSubmit.ok, submitted: lastSubmit.submitted, aborted: lastSubmit.aborted } : null}
              />
              {payrollApproved && <ApproveButton unapproveOnly period={period} readyCount={0} approved approvedCount={approvedCount} />}
            </>
          )}
        </div>
      </section>

      <PayrollReviewBoard rows={rows} timesheetsOk={tsReview.ok} period={period} gustoMembers={gustoMembers} />

      {/* Rate check: folded away unless a rate actually differs. Every count is workers in THIS run. */}
      <details className="surface group border" open={ratePlan.proposals.some((p) => rows.some((r) => !r.excluded && r.key === p.workerKey))}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[12px] text-secondary-text">
          <ChevronRight className="size-3.5 shrink-0 text-meta transition-transform group-open:rotate-90" aria-hidden />
          <span className="font-medium text-foreground">Rate check</span>
          <span className="text-meta">
            Gusto vs Connecteam for the {rc.mapped} linked worker{rc.mapped === 1 ? "" : "s"} in this run:
            {" "}{rc.verifiedMatch} match{rc.differing ? `, ${rc.differing} differ` : ""}{rc.missingSourceRate ? `, ${rc.missingSourceRate} have no Gusto rate` : ""}{rc.incomparableSalaried ? `, ${rc.incomparableSalaried} salaried` : ""}
          </span>
        </summary>
        <div className="border-t border-rule px-4 py-3">
          <RateSyncPanel proposals={ratePlan.proposals} asOf={ratePlan.asOf} comparison={m.rateComparison} />
        </div>
      </details>
    </div>
  );
}

function SummaryFigure({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[18px] font-semibold tabular-nums text-foreground">{value}</span>
      <span className="text-[11px] uppercase tracking-[0.06em] text-meta">{label}</span>
    </div>
  );
}

// ══ TIME SYNC ═══════════════════════════════════════════════════════════════════════════════════════════
async function SyncTab({ period, weeksAgo }: { period: { start: string; end: string; label: string }; weeksAgo: number }): Promise<React.JSX.Element> {
  const records = countTimeEntries(period.start, period.end);
  const last = listSyncRuns(1)[0] ?? null;
  const r = await payrollReview(period);
  const matched = r.workers.filter((w) => w.mappingStatus !== "UNMATCHED").length;
  const unmatched = r.workers.filter((w) => w.mappingStatus === "UNMATCHED").length;

  const stages: { label: string; value: string; state: "ok" | "warn" | "idle" }[] = [
    { label: "Connecteam import", value: r.connecteamOk ? hrs(r.hours) : "unavailable", state: r.connecteamOk ? "ok" : "warn" },
    { label: "Normalized", value: r.connecteamOk ? `${hrs(r.hours)} · ${r.counts.workers} workers` : "—", state: r.connecteamOk ? "ok" : "idle" },
    { label: "Matched (Gusto)", value: String(matched), state: matched > 0 ? "ok" : "idle" },
    { label: "Unmatched", value: String(unmatched), state: unmatched > 0 ? "warn" : "ok" },
    { label: "Valid (ready)", value: String(r.counts.ready), state: r.counts.ready > 0 ? "ok" : "idle" },
    { label: "Requires review", value: String(r.counts.review + r.counts.blocked), state: r.counts.review + r.counts.blocked > 0 ? "warn" : "ok" },
    { label: "Gusto preparation", value: gustoConfigured() ? "ready" : "not connected", state: gustoConfigured() ? "ok" : "warn" },
  ];
  const dot = (s: "ok" | "warn" | "idle") => (s === "ok" ? "bg-positive" : s === "warn" ? "bg-attention" : "bg-[var(--bar)]");

  return (
    <div className="max-w-2xl space-y-4">
      <section className="surface border p-4">
        <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-3 text-[12.5px]">
          <Field label="Source" value="Connecteam" sub={connecteamConfigured() ? "connected" : "not connected"} />
          <Field label="Destination" value="Gusto" sub={gustoConfigured() ? "connected" : "not connected (push disabled)"} />
          <Field label="Pay period" value={period.label} sub={weeksAgo === 1 ? "last week" : `${weeksAgo} weeks ago`} />
          <Field label="Normalized records" value={String(records)} sub="time entries stored" />
        </div>
        <div className="border-t border-rule pt-3">
          <div className="mb-2 text-[10.5px] uppercase tracking-[0.08em] text-meta">Pipeline · {period.label}</div>
          <ol className="space-y-0">
            {stages.map((s, i) => (
              <li key={s.label} className="flex items-center gap-3 py-1.5">
                <span className={`size-2 shrink-0 rounded-full ${dot(s.state)}`} aria-hidden />
                <span className="w-40 shrink-0 text-[12.5px] text-secondary-text">{i + 1}. {s.label}</span>
                <span className={`text-[12.5px] tabular-nums ${s.state === "warn" ? "text-attention" : "text-foreground"}`}>{s.value}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="mt-4 flex items-center gap-3 border-t border-rule pt-4">
          <SyncButton period={period} label="Sync Now" variant="primary" />
          <p className="text-[11.5px] text-meta">
            Pulls Connecteam hours, normalizes + matches workers, reconciles and flags blockers/exceptions. Idempotent — running twice never duplicates hours.{last ? ` Last run ${relTime(last.finishedAt ?? last.startedAt)} · ${last.status.toLowerCase().replace(/_/g, " ")}.` : ""} Gusto push runs only after approval.
          </p>
        </div>
      </section>
    </div>
  );
}

// ══ WORKERS / CONTRACTORS ═══════════════════════════════════════════════════════════════════════════════
async function WorkersTab({ period, mode }: { period: { start: string; end: string; label: string }; mode: "all" | "contractors" }): Promise<React.JSX.Element> {
  const { workers, connecteamOk } = await unifiedWorkers(period);
  const gustoMembers: GustoPick[] = (readGustoSnapshot()?.members ?? []).map((gm) => ({
    id: gm.id, name: gm.preferredName || `${gm.firstName} ${gm.lastName}`.trim() || gm.id, personType: gm.personType, country: gm.country,
  }));
  const filtered = mode === "contractors"
    ? workers.filter((w) => w.workerType === "US_CONTRACTOR" || w.workerType === "INTERNATIONAL_CONTRACTOR")
    : workers;

  if (mode === "all" && !connecteamOk && workers.length === 0) {
    return <EmptyState icon={<Users className="size-5" />} title="No worker data" body="Connecteam isn't reachable, so the roster is unavailable. Connect Connecteam to populate workers." />;
  }
  if (mode === "all" && filtered.length === 0) {
    return <EmptyState icon={<Users className="size-5" />} title="No workers yet" body="Run a sync to populate the worker directory from Connecteam." />;
  }
  if (mode === "contractors") {
    const us = filtered.filter((w) => w.workerType === "US_CONTRACTOR");
    const intl = filtered.filter((w) => w.workerType === "INTERNATIONAL_CONTRACTOR");
    return (
      <div className="space-y-6">
        <WorkerGroup title="US contractors" workers={us} gustoMembers={gustoMembers} />
        <WorkerGroup title="International contractors" workers={intl} gustoMembers={gustoMembers} />
        <TempPaySection period={period} />
      </div>
    );
  }
  return <WorkerTable workers={filtered} gustoMembers={gustoMembers} />;
}

async function TempPaySection({ period }: { period: { start: string; end: string; label: string } }): Promise<React.JSX.Element> {
  const t = await instaworkTempPay(period);
  return (
    <div>
      <h3 className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">
        Instawork temps <span className="text-meta">· paid separately{t.workers.length ? ` (${t.workers.length})` : ""}</span>
      </h3>
      {(t.ok || t.workers.length > 0) && <p className="mb-2 text-[11px] text-meta">{t.note}{t.ok && t.asOf ? ` · gigs as of ${relTime(t.asOf)}` : ""}</p>}
      {!t.ok && t.workers.length === 0 ? (
        <p className="text-[12px] text-meta">Instawork snapshot unavailable — refresh the Instawork pull to estimate temp pay.</p>
      ) : t.workers.length === 0 ? (
        <p className="text-[12px] text-meta">No Instawork gigs booked in this period.</p>
      ) : (
        <div className="surface overflow-x-auto border">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <thead>
              <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
                <th className="px-3 py-2 font-medium">Worker</th>
                <th className="px-3 py-2 text-right font-medium">Gigs</th>
                <th className="px-3 py-2 text-right font-medium">Hours</th>
                <th className="px-3 py-2 text-right font-medium">Estimated</th>
                <th className="px-3 py-2 text-right font-medium">Actual</th>
              </tr>
            </thead>
            <tbody>
              {t.workers.map((w) => (
                <tr key={w.name} className="border-b border-rule/60 last:border-0 hover:bg-[var(--row-hover)]">
                  <td className="px-3 py-2 font-medium text-foreground">{w.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-tertiary-text">{w.gigs || "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{w.hours == null ? "—" : w.hours.toLocaleString("en-US")}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{money(w.estCost)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{w.actualCost == null ? <span className="text-meta">— not imported</span> : money(w.actualCost)}</td>
                </tr>
              ))}
              <tr className="border-t border-rule font-medium">
                <td className="px-3 py-2 text-tertiary-text">Total</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-right tabular-nums text-foreground">{t.totalHours == null ? "—" : t.totalHours.toLocaleString("en-US")}</td>
                <td className="px-3 py-2 text-right tabular-nums text-foreground">{money(t.totalEstCost)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-foreground">{money(t.totalActualCost)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WorkerGroup({ title, workers, gustoMembers }: { title: string; workers: UnifiedWorker[]; gustoMembers: GustoPick[] }): React.JSX.Element {
  return (
    <div>
      <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">{title} <span className="text-meta">({workers.length})</span></h3>
      {workers.length === 0 ? <p className="text-[12px] text-meta">None.</p> : <WorkerTable workers={workers} gustoMembers={gustoMembers} />}
    </div>
  );
}

function WorkerTable({ workers, gustoMembers }: { workers: UnifiedWorker[]; gustoMembers: GustoPick[] }): React.JSX.Element {
  return (
    <div className="surface overflow-x-auto border">
      <table className="w-full min-w-[720px] text-[12.5px]">
        <thead>
          <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
            <th className="px-3 py-2 font-medium">Worker</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Country</th>
            <th className="px-3 py-2 font-medium">Connecteam</th>
            <th className="px-3 py-2 font-medium">Gusto</th>
            <th className="px-3 py-2 text-right font-medium">Rate</th>
            <th className="px-3 py-2 text-right font-medium">Period hours</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Edit</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => (
            <tr key={w.key} className="border-b border-rule/60 last:border-0 hover:bg-[var(--row-hover)]">
              <td className="px-3 py-2">
                <div className="font-medium text-foreground">{w.name}</div>
                {w.email && <div className="text-[11px] text-meta">{w.email}</div>}
              </td>
              <td className="px-3 py-2">
                <span className="text-secondary-text">{WORKER_TYPE_LABEL[w.workerType]}</span>
                {w.typeInferred && <span className="ml-1 text-[10px] text-meta">(inferred)</span>}
              </td>
              <td className="px-3 py-2 text-tertiary-text">{w.country ?? "—"}</td>
              <td className="px-3 py-2">{w.inConnecteam ? <Check /> : <Dash />}</td>
              <td className="px-3 py-2">{w.gustoMapped ? <Check /> : <span className="text-[11px] text-attention">Needs mapping</span>}</td>
              <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{w.payRate != null ? `${money(w.payRate, w.currency)}/hr` : "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{w.periodHours == null ? "—" : w.periodHours.toLocaleString("en-US")}</td>
              <td className="px-3 py-2"><span className={w.active ? "text-positive" : "text-meta"}>{w.active ? "Active" : "Inactive"}</span></td>
              <td className="px-3 py-2 text-right">
                <WorkerEditor
                  worker={{ recordId: w.recordId, connecteamUserId: w.connecteamUserId, name: w.name, workerType: w.workerType, payType: w.payType, payRate: w.payRate, currency: w.currency, country: w.country, gustoId: w.gustoId }}
                  gustoMembers={gustoMembers}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ══ EXCEPTIONS ══════════════════════════════════════════════════════════════════════════════════════════
const SEV_TONE: Record<ExceptionSeverity, string> = {
  CRITICAL: "text-critical bg-critical/15", HIGH: "text-attention bg-attention/15",
  MEDIUM: "text-secondary-text bg-[var(--row)]", LOW: "text-meta bg-[var(--row)]",
};
function ExceptionsTab(): React.JSX.Element {
  const open = listExceptions();
  const active = open.filter((e) => e.status === "OPEN" || e.status === "IN_REVIEW");
  if (active.length === 0) {
    return <EmptyState icon={<CheckCircle2 className="size-5 text-positive" />} title="No open exceptions" body="Nothing is blocking payroll right now. Exceptions appear here after a sync detects an issue." />;
  }
  return (
    <div className="surface divide-y divide-[var(--row-rule)] border">
      {active.map((e) => (
        <div key={e.id} className="flex items-start gap-3 p-3">
          <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SEV_TONE[e.severity]}`}>{e.severity}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-foreground">{e.workerLabel ?? "—"} <span className="ml-1 text-[11px] font-normal text-meta">{e.type.replace(/_/g, " ").toLowerCase()}</span></div>
            <div className="text-[12px] text-secondary-text">{e.description}</div>
            <div className="mt-0.5 text-[10.5px] text-meta">{e.source ?? "—"} · {relTime(e.detectedAt)}</div>
          </div>
          <ExceptionActions id={e.id} reconcilable={!!e.detectKey?.startsWith("RDY:")} />
        </div>
      ))}
    </div>
  );
}

// ══ HISTORY ═════════════════════════════════════════════════════════════════════════════════════════════
function HistoryTab(): React.JSX.Element {
  const runs = listSyncRuns(50);
  if (runs.length === 0) {
    return <EmptyState icon={<History className="size-5" />} title="No sync history yet" body="Every manual and scheduled sync is recorded here with its full result. Run a sync to start the audit trail." />;
  }
  return (
    <div className="surface overflow-x-auto border">
      <table className="w-full min-w-[760px] text-[12.5px]">
        <thead>
          <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Pay period</th>
            <th className="px-3 py-2 text-right font-medium">Hours</th>
            <th className="px-3 py-2 text-right font-medium">Workers</th>
            <th className="px-3 py-2 text-right font-medium">Exceptions</th>
            <th className="px-3 py-2 font-medium">Trigger</th>
            <th className="px-3 py-2 font-medium">By</th>
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b border-rule/60 last:border-0 hover:bg-[var(--row-hover)]">
              <td className="px-3 py-2 text-secondary-text">{relTime(r.finishedAt ?? r.startedAt)}</td>
              <td className="px-3 py-2 text-tertiary-text">{r.periodStart} → {r.periodEnd}</td>
              <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{r.totalHours == null ? "—" : r.totalHours.toLocaleString("en-US")}</td>
              <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{r.workersProcessed ?? "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{r.exceptionsCount ?? "—"}</td>
              <td className="px-3 py-2 text-tertiary-text">{r.trigger}</td>
              <td className="px-3 py-2 text-tertiary-text">{r.initiatedBy ?? "—"}</td>
              <td className="px-3 py-2"><StatusPill status={r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ══ SETTINGS ════════════════════════════════════════════════════════════════════════════════════════════
function SettingsTab(): React.JSX.Element {
  const ctOk = connecteamConfigured();
  const guOk = gustoConfigured();
  const cfg = getPayrollConfig();
  const gustoImport = getLatestImportBySource()["gusto"] ?? null;
  return (
    <div className="max-w-2xl space-y-3">
      <section className="surface border p-4">
        <h3 className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">Connections</h3>
        <div className="space-y-2.5 text-[12.5px]">
          <ConnRow name="Connecteam" role="Operational time source of truth" ok={ctOk} detail={ctOk ? "connected (CONNECTEAM_API_KEY set)" : "not connected"} />
          <ConnRow name="Gusto" role="Payroll system of record — browser tab-replay (Auto-Pull extension)" ok={guOk} detail={guOk ? "connected — pull landed" : "not connected — open Gusto in the office browser (Auto-Pull extension)"} />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3">
          <p className="max-w-sm text-[11.5px] text-meta">
            Gusto no longer syncs on the 10-minute loop. Sync it on demand: the office-browser extension opens one Gusto tab, pulls the roster + pay rates, and closes it.
          </p>
          <SyncGustoButton lastSyncedAt={gustoImport?.ts ?? null} lastOk={gustoImport?.ok ?? false} />
        </div>
      </section>
      <PayrollSettingsForm initial={cfg} />
    </div>
  );
}

// ── small shared presentational helpers ────────────────────────────────────────────────────────────────
function Field({ label, value, sub }: { label: string; value: string; sub?: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-meta">{label}</div>
      <div className="mt-0.5 text-foreground">{value}</div>
      {sub && <div className="text-[11px] text-meta">{sub}</div>}
    </div>
  );
}
function ConnRow({ name, role, ok, detail }: { name: string; role: string; ok: boolean; detail: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-rule bg-[var(--panel)] px-3 py-2">
      <div className="min-w-0">
        <div className="font-medium text-foreground">{name}</div>
        <div className="text-[11px] text-meta">{role}</div>
      </div>
      <div className="flex items-center gap-2 text-right">
        <span className={`size-2 rounded-full ${ok ? "bg-positive" : "bg-attention"}`} aria-hidden />
        <span className={`text-[11.5px] ${ok ? "text-positive" : "text-attention"}`}>{detail}</span>
      </div>
    </div>
  );
}
function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }): React.JSX.Element {
  return (
    <div className="surface flex flex-col items-center gap-2 border px-6 py-14 text-center">
      <span className="text-meta">{icon}</span>
      <div className="text-[13px] font-medium text-foreground">{title}</div>
      <p className="max-w-sm text-[12px] text-meta">{body}</p>
    </div>
  );
}
function StatusPill({ status }: { status: string }): React.JSX.Element {
  const tone = status === "READY" || status === "SYNCED" ? "text-positive bg-positive/12"
    : status === "FAILED" ? "text-critical bg-critical/12"
      : status === "REQUIRES_REVIEW" ? "text-attention bg-attention/12" : "text-meta bg-[var(--row)]";
  return <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${tone}`}>{status.toLowerCase().replace(/_/g, " ")}</span>;
}
function Check(): React.JSX.Element { return <UserCheck className="size-4 text-positive" aria-label="yes" />; }
function Dash(): React.JSX.Element { return <span className="text-meta">—</span>; }
