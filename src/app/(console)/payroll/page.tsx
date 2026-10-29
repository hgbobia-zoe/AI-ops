// HR / Payroll — the Zoe Payroll Control Plane. Reconciliation + control layer between Connecteam (operational
// time source of truth) and Gusto (payroll system of record). The blade's sections are NESTED VERTICAL links
// in the global sidebar (ConsoleNav → People → HR / Payroll → Overview · Payroll Review · Time Sync · Workers
// · Contractors · Exceptions · Payroll History · Settings); there is no in-page horizontal tab row.
//
// ONE authoritative readiness model (lib/payroll/readinessModel.ts) drives every status, count, badge and
// action on Overview + Review, so the two can never disagree for the same period/snapshot. FACTS ONLY — an
// unknown renders as "—"/"unknown", never a fabricated number. Owner/admin only (canManagePayroll + proxy).

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Wallet, Users, UserCheck, History, Settings as SettingsIcon,
  ArrowRight, ChevronLeft, ChevronRight, CheckCircle2, CircleAlert, Ban, HelpCircle, Clock,
  ClipboardCheck, Plug, CalendarClock, BrainCircuit, Search,
} from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { connecteamConfigured } from "@/lib/connecteam";
import { completedWeeksBack } from "@/lib/payroll/period";
import { clampWeeksAgo, periodNavHref } from "@/lib/payroll/nav";
import { derivePayrollReadiness, payrollApprovability } from "@/lib/payroll/readinessModel";
import { unifiedWorkers } from "@/lib/payroll/workers";
import { payrollReview } from "@/lib/payroll/review";
import { listExceptions, listSyncRuns, countTimeEntries } from "@/lib/payroll/store";
import { gustoConfigured } from "@/lib/payroll/gusto";
import { instaworkTempPay } from "@/lib/payroll/instawork";
import {
  WORKER_TYPE_LABEL, MAPPING_STATUS_LABEL, APPROVAL_STATUS_LABEL, UNIFIED_STATUS_LABEL, RATE_SOURCE_LABEL,
  type UnifiedWorker, type ExceptionSeverity, type PayrollReadinessModel, type PayrollTone, type GateState,
  type UnifiedWorkerRow, type UnifiedWorkerStatus, type AttentionGroup, type PayrollSourceHealth,
  type PayrollActivityEvent,
} from "@/lib/payroll/types";
import { getPayrollConfig } from "@/lib/payroll/config";
import { readGustoSnapshot } from "@/lib/payroll/gustoSnapshot";
import { getLatestImportBySource } from "@/lib/pull/state";
import { PayrollSubnav } from "@/components/payroll/PayrollSubnav";
import { WorkerEditor, type GustoPick } from "@/components/payroll/WorkerEditor";
import { SyncButton } from "@/components/payroll/SyncButton";
import { SyncGustoButton } from "@/components/payroll/SyncGustoButton";
import { PushGustoHoursButton } from "@/components/payroll/PushGustoHoursButton";
import { gustoPushDisabled, readGustoPushResult } from "@/lib/payroll/gustoPushState";
import { ApproveButton } from "@/components/payroll/ApproveButton";
import { PayrollSettingsForm } from "@/components/payroll/PayrollSettingsForm";
import { ExceptionActions } from "@/components/payroll/ExceptionActions";
import { ExcludeControl } from "@/components/payroll/ExcludeControl";
import { ApproveControl } from "@/components/payroll/ApproveControl";
import { RateSyncPanel } from "@/components/payroll/RateSyncPanel";
import { buildRateSyncPlan } from "@/lib/payroll/rateSync";

export const dynamic = "force-dynamic";

type Tab = "overview" | "review" | "sync" | "workers" | "contractors" | "exceptions" | "history" | "settings";
const TAB_KEYS: Tab[] = ["overview", "review", "sync", "workers", "contractors", "exceptions", "history", "settings"];
const TAB_TITLE: Record<Tab, string> = {
  overview: "Overview", review: "Payroll Review", sync: "Time Sync", workers: "Workers",
  contractors: "Contractors", exceptions: "Exceptions", history: "Payroll History", settings: "Settings",
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

// ── tone tokens (colour ALWAYS paired with text/icon — never colour alone) ──────────────────────────────
const TONE_BADGE: Record<PayrollTone, string> = {
  critical: "text-critical border-critical/40 bg-critical/10",
  attention: "text-attention border-attention/40 bg-attention/10",
  positive: "text-positive border-positive/40 bg-positive/10",
  neutral: "text-tertiary-text border-border bg-[var(--row)]",
};
function StatusGlyph({ tone, className = "size-4" }: { tone: PayrollTone; className?: string }): React.JSX.Element {
  if (tone === "positive") return <CheckCircle2 className={className} aria-hidden />;
  if (tone === "critical") return <Ban className={className} aria-hidden />;
  if (tone === "attention") return <CircleAlert className={className} aria-hidden />;
  return <HelpCircle className={className} aria-hidden />;
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

  // Two vertical menus: the global sidebar (ConsoleNav, in the console layout) + this blade's own vertical
  // section menu next to it (PayrollSubnav), replacing the old horizontal tab row.
  return (
    <div className="flex flex-col lg:flex-row lg:items-start">
      <PayrollSubnav activeTab={tab} weeksAgo={weeksAgo} />
      <main className="mx-auto w-full min-w-0 max-w-[1240px] flex-1 p-4 pb-12 leading-[1.35] md:p-6">
        <PayrollHeader tab={tab} period={period} weeksAgo={weeksAgo} />
        {tab === "overview" && <OverviewTab period={period} weeksAgo={weeksAgo} />}
        {tab === "review" && <ReviewTab period={period} statusFilter={sp.status ?? "all"} q={(sp.q ?? "").trim()} weeksAgo={weeksAgo} />}
        {tab === "sync" && <SyncTab period={period} weeksAgo={weeksAgo} />}
        {tab === "workers" && <WorkersTab period={period} mode="all" />}
        {tab === "contractors" && <WorkersTab period={period} mode="contractors" />}
        {tab === "exceptions" && <ExceptionsTab />}
        {tab === "history" && <HistoryTab />}
        {tab === "settings" && <SettingsTab />}
      </main>
    </div>
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
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[11.5px] text-meta">
        <span>People</span>
        <ChevronRight className="size-3" aria-hidden />
        <Link href="/payroll" className="transition-colors hover:text-foreground">HR &amp; Payroll</Link>
        <ChevronRight className="size-3" aria-hidden />
        <span className="text-tertiary-text" aria-current="page">{TAB_TITLE[tab]}</span>
      </nav>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
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
        <span className="inline-flex items-center gap-1.5"><CalendarClock className="size-3.5" aria-hidden /> Payroll runs {payrollDeadlineText(cfg)}</span>
        <span className="inline-flex items-center gap-1.5"><Clock className="size-3.5" aria-hidden /> Hours last verified {relTime(last?.finishedAt ?? last?.startedAt ?? null)}{last ? ` · ${last.status.toLowerCase().replace(/_/g, " ")}` : ""}</span>
        <span className="ml-auto"><SyncButton period={period} label="Sync hours" variant="secondary" /></span>
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
async function OverviewTab({ period, weeksAgo }: { period: { start: string; end: string; label: string }; weeksAgo: number }): Promise<React.JSX.Element> {
  const m = await derivePayrollReadiness(period);
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_304px]">
      {/* MAIN COLUMN */}
      <div className="flex min-w-0 flex-col gap-5">
        <StatusPanel m={m} weeksAgo={weeksAgo} />
        <NeedsAttention m={m} />
        <PeriodSummary m={m} />
        <RecentActivity events={m.activity} />
      </div>
      {/* RIGHT COLUMN */}
      <aside className="flex min-w-0 flex-col gap-4">
        <ScheduleCard m={m} />
        <SourceHealthCard sources={m.sources} />
        <ConfigCard m={m} />
        <AiManagerLink />
      </aside>
    </div>
  );
}

// ONE authoritative status panel — no competing banners. Status + explanation + next valid action + the
// pipeline gates + the reconciled counts.
function StatusPanel({ m, weeksAgo }: { m: PayrollReadinessModel; weeksAgo: number }): React.JSX.Element {
  const periodQS = weeksAgo > 1 ? `&weeksAgo=${weeksAgo}` : "";
  const na = m.nextAction;
  return (
    <section className="surface border p-4" aria-labelledby="payroll-status-h">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="payroll-status-h" className="text-[10.5px] uppercase tracking-[0.1em] text-meta">Payroll status</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-[14px] font-semibold ${TONE_BADGE[m.tone]}`}>
              <StatusGlyph tone={m.tone} /> {m.headline}
            </span>
            {m.approval && (
              <span className="rounded border border-border bg-[var(--row)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-tertiary-text">
                {APPROVAL_STATUS_LABEL[m.approval.status]}{m.approval.approvedBy ? ` · ${m.approval.approvedBy}` : ""}
              </span>
            )}
          </div>
          <p className="mt-2 max-w-xl text-[12.5px] leading-snug text-secondary-text">{m.explain}</p>
        </div>
        {/* The single next valid action */}
        <NextActionControl m={m} periodQS={periodQS} na={na} />
      </div>

      {/* Reconciled counts — identical to the Review tab (same model) */}
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-rule pt-3 text-[12px]">
        <Count n={m.counts.included} label="in run" tone="neutral" />
        <Count n={m.counts.ready} label="ready" tone="positive" />
        <Count n={m.counts.actionRequired} label="to review" tone="attention" />
        <Count n={m.counts.unverified} label="unverified" tone="attention" />
        <Count n={m.counts.blocked} label="blocked" tone="critical" />
        {m.counts.excluded > 0 && <Count n={m.counts.excluded} label="excluded" tone="neutral" />}
      </div>

      {/* Pipeline gates — each labelled with its own state (the reconciliation made explicit) */}
      <GateStrip m={m} />
    </section>
  );
}

function NextActionControl({ m, periodQS, na }: { m: PayrollReadinessModel; periodQS: string; na: PayrollReadinessModel["nextAction"] }): React.JSX.Element {
  // Hours gate → the real Sync control (dedupe + progress). Navigable gates → a Link. External/manual steps
  // (approve timesheets in Connecteam) → a labelled static control, never a dead link.
  if (na.gate === "hours") {
    return (
      <div className="flex flex-col items-end gap-1">
        <SyncButton period={m.period} label="Sync hours" variant="primary" />
        <span className="max-w-[15rem] text-right text-[11px] text-meta">{na.explain}</span>
      </div>
    );
  }
  const href = na.href ? (na.href.includes("?") ? `${na.href}${periodQS}` : `${na.href}${periodQS ? `?${periodQS.slice(1)}` : ""}`) : null;
  return (
    <div className="flex flex-col items-end gap-1">
      {href ? (
        <Link href={href} className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90">
          <ArrowRight className="size-4" aria-hidden /> {na.label}
        </Link>
      ) : (
        <span className={`inline-flex h-9 items-center justify-center gap-2 rounded-md border px-4 text-[13px] font-medium ${TONE_BADGE.attention}`}>
          <CircleAlert className="size-4" aria-hidden /> {na.label}
        </span>
      )}
      <span className="max-w-[16rem] text-right text-[11px] leading-snug text-meta">{na.explain}</span>
    </div>
  );
}

const GATE_STATE_UI: Record<GateState, { dot: string; label: string; tone: PayrollTone }> = {
  PASS: { dot: "bg-positive", label: "Done", tone: "positive" },
  ACTION: { dot: "bg-attention", label: "Action", tone: "attention" },
  UNVERIFIED: { dot: "bg-attention", label: "Unverified", tone: "attention" },
  BLOCKED: { dot: "bg-critical", label: "Blocked", tone: "critical" },
  UNAVAILABLE: { dot: "bg-critical", label: "Unavailable", tone: "critical" },
  PENDING: { dot: "bg-[var(--bar)]", label: "Pending", tone: "neutral" },
  NA: { dot: "bg-[var(--bar)]", label: "—", tone: "neutral" },
};
function GateStrip({ m }: { m: PayrollReadinessModel }): React.JSX.Element {
  return (
    <ol className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-rule pt-3 sm:grid-cols-3 lg:grid-cols-5">
      {m.gates.map((g) => {
        const ui = GATE_STATE_UI[g.state];
        return (
          <li key={g.key} className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`size-2 shrink-0 rounded-full ${ui.dot}`} aria-hidden />
              <span className="truncate text-[11.5px] font-medium text-secondary-text" title={g.label}>{g.label}</span>
            </div>
            <div className={`mt-0.5 pl-3.5 text-[10.5px] ${ui.tone === "positive" ? "text-positive" : ui.tone === "critical" ? "text-critical" : ui.tone === "attention" ? "text-attention" : "text-meta"}`}>
              {ui.label}{g.affected > 0 ? ` · ${g.affected}` : ""}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Count({ n, label, tone }: { n: number; label: string; tone: PayrollTone }): React.JSX.Element {
  const c = tone === "positive" ? "text-positive" : tone === "attention" ? "text-attention" : tone === "critical" ? "text-critical" : "text-tertiary-text";
  return <span className={c}><span className="font-semibold tabular-nums">{n}</span> <span className="text-meta">{label}</span></span>;
}

const SEV_CHIP: Record<AttentionGroup["severity"], { cls: string; label: string }> = {
  blocker: { cls: "bg-critical/15 text-critical", label: "Blocker" },
  review: { cls: "bg-attention/15 text-attention", label: "Review" },
  unverified: { cls: "bg-attention/15 text-attention", label: "Unverified" },
  setup: { cls: "bg-[var(--row)] text-tertiary-text", label: "Setup" },
};
function NeedsAttention({ m }: { m: PayrollReadinessModel }): React.JSX.Element {
  const groups = m.attention;
  return (
    <section className="surface border p-4" aria-labelledby="needs-attn-h">
      <div className="flex items-center justify-between gap-2">
        <h2 id="needs-attn-h" className="text-[10.5px] uppercase tracking-[0.1em] text-meta">Needs attention</h2>
        {groups.length > 0 && <Link href="/payroll?tab=exceptions" className="text-[11px] text-meta transition-colors hover:text-foreground">All exceptions →</Link>}
      </div>
      {groups.length === 0 ? (
        <div className="mt-3 flex items-center gap-2 text-[12.5px] text-positive">
          <CheckCircle2 className="size-4" aria-hidden /> Nothing needs attention for this period.
        </div>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-[var(--row-rule)]">
          {groups.slice(0, 6).map((g) => {
            const chip = SEV_CHIP[g.severity];
            return (
              <li key={g.code} className="py-2 first:pt-0">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-2.5">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide ${chip.cls}`}>{chip.label}</span>
                    <span className="min-w-0 flex-1 text-[12.5px] text-foreground">
                      {g.title} <span className="text-meta">· {g.count} worker{g.count === 1 ? "" : "s"}</span>
                    </span>
                    {g.action.href ? (
                      <Link href={g.action.href} className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-secondary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">{g.action.label}</Link>
                    ) : (
                      <span className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-meta">{g.action.label}</span>
                    )}
                  </summary>
                  <div className="mt-1.5 pl-[3.1rem] text-[11.5px] text-meta">
                    {g.detail && <p className="mb-1">{g.detail}</p>}
                    <span>{g.workers.map((w) => w.name).join(", ")}</span>
                  </div>
                </details>
              </li>
            );
          })}
          {groups.length > 6 && <li className="pt-2 text-[11px] text-meta">…and {groups.length - 6} more. <Link href="/payroll?tab=review" className="underline-offset-2 hover:underline">Open Payroll Review</Link>.</li>}
        </ul>
      )}
    </section>
  );
}

function PeriodSummary({ m }: { m: PayrollReadinessModel }): React.JSX.Element {
  const t = m.totals;
  const grossSub = t.estGross == null ? "no costable rates" : t.estGrossPartial ? "floor · some rates missing" : "from hours × rate";
  return (
    <section className="surface border p-4" aria-labelledby="summary-h">
      <h2 id="summary-h" className="text-[10.5px] uppercase tracking-[0.1em] text-meta">Period summary</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Workers in run" value={String(m.counts.included)} sub={`${m.counts.ready} ready · ${m.counts.excluded} excluded`} />
        <Stat label="Recorded hours" value={hrs(t.hours)} sub={m.connecteamOk ? "actual · Connecteam" : "source unavailable"} tone={m.connecteamOk ? undefined : "attention"} />
        <Stat label="Est. gross pay" value={t.estGross == null ? "unknown" : money(t.estGross)} sub={grossSub} tone={t.estGross == null ? "attention" : undefined} />
        <Stat label="Approved hours" value={t.approvedHours == null ? "unknown" : hrs(t.approvedHours)} sub={m.approvalKnown ? "verified in Connecteam" : "approval not exposed"} tone={m.approvalKnown ? undefined : "attention"} />
      </div>
      <p className="mt-2.5 text-[11px] text-meta">
        Estimated gross is hours × the known rate for costable workers — an in-app estimate, not a payroll cost or bank debit. Gusto applies its own stored rate on the actual run.
      </p>
    </section>
  );
}

const ACTIVITY_DOT: Record<PayrollTone, string> = { positive: "bg-positive", attention: "bg-attention", critical: "bg-critical", neutral: "bg-[var(--bar)]" };
function RecentActivity({ events }: { events: PayrollActivityEvent[] }): React.JSX.Element {
  return (
    <section className="surface border p-4" aria-labelledby="activity-h">
      <h2 id="activity-h" className="text-[10.5px] uppercase tracking-[0.1em] text-meta">Recent payroll activity</h2>
      {events.length === 0 ? (
        <p className="mt-3 text-[12px] text-meta">No payroll activity recorded yet. Syncs, reviews, approvals and pushes appear here with who did them.</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-[var(--row-rule)]">
          {events.map((e) => (
            <li key={e.id} className="flex items-center gap-2.5 py-1.5 first:pt-0 text-[12px]">
              <span className={`size-1.5 shrink-0 rounded-full ${ACTIVITY_DOT[e.tone]}`} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-secondary-text">{e.label}{e.outcome ? <span className="text-meta"> · {e.outcome}</span> : ""}</span>
              <span className="shrink-0 text-[11px] text-meta">{e.actor ?? "system"} · {relTime(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[10.5px] text-meta">Zoe approval records a sign-off; it is distinct from the Gusto draft push and from payroll being submitted/processed in Gusto.</p>
    </section>
  );
}

// ── Right column ───────────────────────────────────────────────────────────────────────────────────────
function ScheduleCard({ m }: { m: PayrollReadinessModel }): React.JSX.Element {
  return (
    <section className="surface border p-4" aria-labelledby="sched-h">
      <h2 id="sched-h" className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-meta"><CalendarClock className="size-3.5" aria-hidden /> Payroll schedule</h2>
      <dl className="mt-2.5 space-y-2 text-[12px]">
        <RailRow label="Payroll runs" value={m.schedule.deadlineLabel} />
        <RailRow label="Readiness pre-check" value={m.schedule.precheckLabel ?? "off"} muted={!m.schedule.precheckLabel} />
        <RailRow label="Auto hours-sync" value={m.schedule.autoSyncLabel ?? "off"} muted={!m.schedule.autoSyncLabel} />
      </dl>
      <p className="mt-2 text-[10.5px] text-meta">Payday isn&apos;t configured here, so it isn&apos;t shown. Set the schedule in Settings.</p>
    </section>
  );
}

const SRC_STATE: Record<PayrollSourceHealth["state"], { dot: string; label: string; cls: string }> = {
  ok: { dot: "bg-positive", label: "OK", cls: "text-positive" },
  stale: { dot: "bg-attention", label: "Stale", cls: "text-attention" },
  unavailable: { dot: "bg-critical", label: "Unavailable", cls: "text-critical" },
  idle: { dot: "bg-[var(--bar)]", label: "No pull", cls: "text-meta" },
  off: { dot: "bg-[var(--bar)]", label: "Off", cls: "text-meta" },
};
function SourceHealthCard({ sources }: { sources: PayrollSourceHealth[] }): React.JSX.Element {
  return (
    <section className="surface border p-4" aria-labelledby="src-h">
      <h2 id="src-h" className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-meta"><Plug className="size-3.5" aria-hidden /> Data sources</h2>
      <ul className="mt-2.5 space-y-2.5">
        {sources.map((s) => {
          const st = SRC_STATE[s.state];
          return (
            <li key={s.key} className="text-[12px]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">{s.label}</span>
                <span className={`inline-flex items-center gap-1.5 text-[11px] ${st.cls}`}><span className={`size-1.5 rounded-full ${st.dot}`} aria-hidden /> {st.label}</span>
              </div>
              <div className="text-[11px] text-meta">{s.role}</div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-meta">
                <span>{s.detail}{s.lastAt ? ` · ${relTime(s.lastAt)}` : ""}</span>
                {s.fixHref && <Link href={s.fixHref} className="shrink-0 text-tertiary-text underline-offset-2 hover:text-foreground hover:underline">Fix</Link>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ConfigCard({ m }: { m: PayrollReadinessModel }): React.JSX.Element {
  return (
    <section className="surface border p-4" aria-labelledby="cfg-h">
      <h2 id="cfg-h" className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-meta"><SettingsIcon className="size-3.5" aria-hidden /> Automation</h2>
      <dl className="mt-2.5 space-y-2 text-[12px]">
        <RailRow label="Pre-check" value={m.schedule.precheckLabel ? "scheduled" : "manual only"} muted={!m.schedule.precheckLabel} />
        <RailRow label="Auto-sync" value={m.schedule.autoSyncLabel ? "on" : "off"} muted={!m.schedule.autoSyncLabel} />
      </dl>
      <Link href="/payroll?tab=settings" className="mt-2.5 inline-flex items-center gap-1 text-[11.5px] text-tertiary-text transition-colors hover:text-foreground">Configure in Settings <ArrowRight className="size-3" aria-hidden /></Link>
    </section>
  );
}

// Honest, compact access to the AI Payroll Manager — NOT a claim that an agent is working. Replaces the
// oversized "AI employees working here / COMING" panel.
function AiManagerLink(): React.JSX.Element {
  return (
    <Link href="/ai-org/employees" className="surface flex items-center gap-2.5 border p-3 transition-colors hover:bg-[var(--row-hover)]">
      <BrainCircuit className="size-4 text-meta" aria-hidden />
      <span className="min-w-0 flex-1 text-[12px]">
        <span className="font-medium text-secondary-text">AI Payroll Manager</span>
        <span className="block text-[11px] text-meta">Not active — manage in AI Org</span>
      </span>
      <ArrowRight className="size-3.5 text-meta" aria-hidden />
    </Link>
  );
}

function RailRow({ label, value, muted }: { label: string; value: string; muted?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-meta">{label}</dt>
      <dd className={muted ? "text-meta" : "font-medium text-secondary-text"}>{value}</dd>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "attention" }): React.JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-meta">{label}</div>
      <div className={`mt-1 text-[17px] font-semibold tabular-nums leading-tight ${tone === "attention" ? "text-attention" : "text-foreground"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[10.5px] text-meta">{sub}</div>}
    </div>
  );
}

// ══ PAYROLL REVIEW ══════════════════════════════════════════════════════════════════════════════════════
type ReviewFilter = "all" | "ready" | "review" | "unverified" | "blocked" | "excluded";
const FILTER_LABEL: Record<ReviewFilter, string> = {
  all: "All in run", ready: "Ready", review: "To review", unverified: "Unverified", blocked: "Blocked", excluded: "Excluded",
};
const WSTATUS_UI: Record<UnifiedWorkerStatus, { label: string; cls: string }> = {
  READY: { label: "Ready", cls: "text-positive" },
  ACTION_REQUIRED: { label: "To review", cls: "text-attention" },
  UNVERIFIED: { label: "Unverified", cls: "text-attention" },
  BLOCKED: { label: "Blocked", cls: "text-critical" },
  EXCLUDED: { label: "Excluded", cls: "text-meta" },
};

async function ReviewTab({ period, statusFilter, q, weeksAgo }: {
  period: { start: string; end: string; label: string }; statusFilter: string; q: string; weeksAgo: number;
}): Promise<React.JSX.Element> {
  const [m, ratePlan] = await Promise.all([derivePayrollReadiness(period), buildRateSyncPlan(period.end)]);
  if (m.status === "NO_DATA" || (m.counts.included === 0 && m.counts.excluded === 0)) {
    return <EmptyState icon={<ClipboardCheck className="size-5" />} title="Nothing to review yet" body="No worker hours for this period (or Connecteam is unavailable). Sync hours, then review." />;
  }
  const appr = payrollApprovability(m, false);
  const gustoMembers: GustoPick[] = (readGustoSnapshot()?.members ?? []).map((gm) => ({
    id: gm.id, name: gm.preferredName || `${gm.firstName} ${gm.lastName}`.trim() || gm.id, personType: gm.personType, country: gm.country,
  }));

  const filter = (["all", "ready", "review", "unverified", "blocked", "excluded"].includes(statusFilter) ? statusFilter : "all") as ReviewFilter;
  const counts: Record<ReviewFilter, number> = {
    all: m.workers.length,
    ready: m.workers.filter((w) => w.status === "READY").length,
    review: m.workers.filter((w) => w.status === "ACTION_REQUIRED").length,
    unverified: m.workers.filter((w) => w.status === "UNVERIFIED").length,
    blocked: m.workers.filter((w) => w.status === "BLOCKED").length,
    excluded: m.excludedWorkers.length,
  };
  const ql = q.toLowerCase();
  let rows = filter === "all" ? m.workers
    : filter === "ready" ? m.workers.filter((w) => w.status === "READY")
      : filter === "review" ? m.workers.filter((w) => w.status === "ACTION_REQUIRED")
        : filter === "unverified" ? m.workers.filter((w) => w.status === "UNVERIFIED")
          : filter === "blocked" ? m.workers.filter((w) => w.status === "BLOCKED")
            : m.excludedWorkers;
  if (ql) rows = rows.filter((w) => w.name.toLowerCase().includes(ql));
  const wQS = weeksAgo > 1 ? `&weeksAgo=${weeksAgo}` : "";
  const filterHref = (f: ReviewFilter): string => `/payroll?tab=review&status=${f}${wQS}`;

  return (
    <div className="flex flex-col gap-5">
      {/* Action summary — status + counts + the approval control (persistent, explains what approve does) */}
      <section className="surface flex flex-wrap items-center justify-between gap-4 border p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-[13px] font-semibold ${TONE_BADGE[m.tone]}`}>
              <StatusGlyph tone={m.tone} /> {UNIFIED_STATUS_LABEL[m.status]}
            </span>
            <span className="text-[12px] text-meta">{m.counts.included} in run · {hrs(m.totals.hours)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px]">
            <Count n={counts.ready} label="ready" tone="positive" />
            <Count n={counts.review} label="to review" tone="attention" />
            <Count n={counts.unverified} label="unverified" tone="attention" />
            <Count n={counts.blocked} label="blocked" tone="critical" />
            {counts.excluded > 0 && <Count n={counts.excluded} label="excluded" tone="neutral" />}
          </div>
        </div>
        <ApproveButton period={period} readyCount={appr.readyKeys.length} acknowledgeableCount={appr.acknowledgeableKeys.length} ackReason={appr.ackReason} />
      </section>

      <RateSyncPanel proposals={ratePlan.proposals} asOf={ratePlan.asOf} comparison={m.rateComparison} />

      {/* Filters + search */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {(["all", "ready", "review", "unverified", "blocked", "excluded"] as ReviewFilter[]).map((f) => (
            <Link key={f} href={filterHref(f)} aria-current={filter === f ? "true" : undefined}
              className={`rounded-md border px-2.5 py-1 text-[11.5px] transition-colors ${filter === f ? "border-foreground/30 bg-foreground/[0.08] text-foreground" : "border-border text-meta hover:text-foreground"}`}>
              {FILTER_LABEL[f]} <span className="tabular-nums text-meta">({counts[f]})</span>
            </Link>
          ))}
        </div>
        <form className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2 py-1" action="/payroll">
          <input type="hidden" name="tab" value="review" />
          {filter !== "all" && <input type="hidden" name="status" value={filter} />}
          {weeksAgo > 1 && <input type="hidden" name="weeksAgo" value={String(weeksAgo)} />}
          <Search className="size-3.5 text-meta" aria-hidden />
          <input name="q" defaultValue={q} placeholder="Search workers" aria-label="Search workers" className="w-36 bg-transparent text-[12px] text-foreground outline-none placeholder:text-meta" />
        </form>
      </div>

      <ReviewTable rows={rows} filter={filter} period={period} gustoMembers={gustoMembers} />
      <p className="text-[11px] text-meta">
        Eligibility (the status column) is computed from the gates; it is not the same as the recorded Zoe approval. Approving records a sign-off for the eligible workers and does NOT submit or run payroll in Gusto. Excluded workers are kept here for reference and are never part of payable totals.
      </p>
    </div>
  );
}

function rateCell(w: UnifiedWorkerRow): React.JSX.Element {
  if (w.payRate == null) return <span className="text-attention">missing</span>;
  const src = w.rateSource ? RATE_SOURCE_LABEL[w.rateSource] : null;
  return <span>{money(w.payRate, w.currency)}/hr{src && <span className="ml-1 text-[10px] text-meta">· {src}</span>}</span>;
}
const APPROVAL_UI: Record<UnifiedWorkerRow["approvalState"], { label: string; cls: string }> = {
  APPROVED: { label: "Approved", cls: "text-positive" },
  UNAPPROVED: { label: "Unapproved", cls: "text-attention" },
  UNVERIFIED: { label: "Unverified", cls: "text-attention" },
  NA: { label: "—", cls: "text-meta" },
};

function ReviewTable({ rows, filter, period, gustoMembers }: {
  rows: UnifiedWorkerRow[]; filter: ReviewFilter; period: { start: string; end: string; label: string }; gustoMembers: GustoPick[];
}): React.JSX.Element {
  if (rows.length === 0) {
    return <div className="surface border px-4 py-10 text-center text-[12.5px] text-meta">No workers in this view.</div>;
  }
  const excluded = filter === "excluded";
  return (
    <div className="surface border">
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full min-w-[1000px] text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-[var(--panel)]">
            <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
              <th className="px-3 py-2.5 font-medium">Worker</th>
              <th className="px-3 py-2.5 font-medium">Type</th>
              <th className="px-3 py-2.5 text-right font-medium">Hours</th>
              <th className="px-3 py-2.5 text-right font-medium">Rate / source</th>
              <th className="px-3 py-2.5 text-right font-medium">Est. gross</th>
              <th className="px-3 py-2.5 font-medium">Approval</th>
              <th className="px-3 py-2.5 font-medium">Gusto</th>
              <th className="px-3 py-2.5 font-medium">Status / issues</th>
              <th className="px-3 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => {
              const st = WSTATUS_UI[w.status];
              const ap = APPROVAL_UI[w.approvalState];
              return (
                <tr key={w.key} className="border-b border-rule/60 last:border-0 hover:bg-[var(--row-hover)]">
                  <td className="px-3 py-2.5 font-medium text-foreground">{w.name}{w.accepted && <span className="ml-1.5 rounded bg-[var(--row)] px-1 py-0.5 text-[9.5px] font-normal text-tertiary-text">accepted</span>}</td>
                  <td className="px-3 py-2.5 text-tertiary-text">{WORKER_TYPE_LABEL[w.workerType]}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-secondary-text">{w.hours == null ? "—" : w.hours.toLocaleString("en-US")}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-secondary-text">{rateCell(w)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-secondary-text">{money(w.estPay, w.currency)}</td>
                  <td className="px-3 py-2.5"><span className={`text-[11.5px] ${ap.cls}`}>{excluded ? "—" : ap.label}</span></td>
                  <td className="px-3 py-2.5"><span className={w.gustoMapped ? "text-secondary-text" : "text-attention"}>{MAPPING_STATUS_LABEL[w.mappingStatus]}</span></td>
                  <td className="px-3 py-2.5">
                    {excluded ? (
                      <span className="text-[11.5px] text-meta">
                        <span className="rounded bg-[var(--row)] px-1.5 py-0.5 text-[10px] text-tertiary-text">{w.excludeMode === "period" ? "This period" : "Permanent"}</span>
                        {w.excludeReason ? <span className="ml-1.5">{w.excludeReason}</span> : null}
                      </span>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[11.5px] font-medium ${st.cls}`}>{st.label}</span>
                        {w.issues.length > 0 && (
                          <span className="flex flex-wrap gap-1">
                            {w.issues.slice(0, 3).map((i) => (
                              <span key={i.code} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${i.severity === "blocker" ? "bg-critical/15 text-critical" : i.severity === "setup" ? "bg-[var(--row)] text-meta" : "bg-attention/15 text-attention"}`}>{i.label}</span>
                            ))}
                            {w.issues.length > 3 && <span className="text-[10px] text-meta">+{w.issues.length - 3}</span>}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {excluded ? (
                      <ExcludeControl workerKey={w.key} recordId={w.recordId} connecteamUserId={w.connecteamUserId} name={w.name} periodStart={period.start} periodEnd={period.end} excluded excludeMode={w.excludeMode} />
                    ) : (
                      <div className="flex items-center justify-end gap-1.5">
                        {w.status === "ACTION_REQUIRED" && <ApproveControl workerKey={w.key} name={w.name} periodStart={period.start} periodEnd={period.end} />}
                        {w.accepted && <ApproveControl workerKey={w.key} name={w.name} periodStart={period.start} periodEnd={period.end} accepted acceptedBy={w.acceptedBy} />}
                        <WorkerEditor
                          worker={{ recordId: w.recordId, connecteamUserId: w.connecteamUserId, name: w.name, workerType: w.workerType, payType: w.payType, payRate: w.payRate, currency: w.currency, country: w.country, gustoId: w.gustoId }}
                          gustoMembers={gustoMembers}
                        />
                        <ExcludeControl workerKey={w.key} recordId={w.recordId} connecteamUserId={w.connecteamUserId} name={w.name} periodStart={period.start} periodEnd={period.end} />
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
  const which = "previous" as const;
  const ctOk = connecteamConfigured();
  const guOk = gustoConfigured();
  const cfg = getPayrollConfig();
  const gustoImport = getLatestImportBySource()["gusto"] ?? null;
  const pushDisabled = gustoPushDisabled();
  const lastPush = readGustoPushResult();
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
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3">
          <p className="max-w-sm text-[11.5px] text-meta">
            Push reconciled hours into the current Gusto <span className="font-medium text-secondary-text">DRAFT</span> payroll run. Runs in <span className="font-medium text-secondary-text">this Chrome</span> via the Auto-Pull extension, using your own signed-in Gusto session (write is audited to you). It never submits, runs, or approves payroll.
          </p>
          <PushGustoHoursButton
            which={which}
            disabled={pushDisabled}
            lastPush={lastPush ? { at: lastPush.at, ok: lastPush.ok, aborted: lastPush.aborted, pushed: lastPush.pushed, skipped: lastPush.skipped, failed: lastPush.failed } : null}
          />
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
