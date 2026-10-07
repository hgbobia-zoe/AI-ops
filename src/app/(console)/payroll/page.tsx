// HR / Payroll — the Zoe Payroll Control Plane. The reconciliation + control layer between Connecteam
// (operational time source of truth) and Gusto (payroll system of record). One blade, in-page tabs:
// Overview (Payroll Command Center) · Time Sync · Workers · Contractors · Exceptions · History · Settings.
// Owner/admin only (canManagePayroll; the proxy also gates /payroll). FACTS ONLY — an unknown is "—",
// never a fabricated number. RULES CALCULATE (the services), the UI only renders.

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Wallet, RefreshCw, Users, UserCheck, Globe2, AlertTriangle, History, Settings,
  ArrowRight, Boxes, CheckCircle2, CircleAlert, ClipboardCheck, Ban,
} from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { connecteamConfigured } from "@/lib/connecteam";
import { namedPeriod } from "@/lib/payroll/period";
import { payrollOverview } from "@/lib/payroll/overview";
import { unifiedWorkers } from "@/lib/payroll/workers";
import { payrollReview } from "@/lib/payroll/review";
import { listExceptions, listSyncRuns, countTimeEntries, getApproval } from "@/lib/payroll/store";
import { gustoConfigured } from "@/lib/payroll/gusto";
import { instaworkTempPay } from "@/lib/payroll/instawork";
import {
  WORKER_TYPE_LABEL, MAPPING_STATUS_LABEL, APPROVAL_STATUS_LABEL,
  type UnifiedWorker, type ExceptionSeverity, type ReviewStatus, type ReviewWorker,
} from "@/lib/payroll/types";
import { getPayrollConfig } from "@/lib/payroll/config";
import { SyncButton } from "@/components/payroll/SyncButton";
import { ApproveButton } from "@/components/payroll/ApproveButton";
import { PayrollSettingsForm } from "@/components/payroll/PayrollSettingsForm";

export const dynamic = "force-dynamic";

type Tab = "overview" | "review" | "sync" | "workers" | "contractors" | "exceptions" | "history" | "settings";
const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: "overview", label: "Overview", icon: <Wallet className="size-3.5" /> },
  { key: "review", label: "Payroll Review", icon: <ClipboardCheck className="size-3.5" /> },
  { key: "sync", label: "Time Sync", icon: <RefreshCw className="size-3.5" /> },
  { key: "workers", label: "Workers", icon: <Users className="size-3.5" /> },
  { key: "contractors", label: "Contractors", icon: <Globe2 className="size-3.5" /> },
  { key: "exceptions", label: "Exceptions", icon: <AlertTriangle className="size-3.5" /> },
  { key: "history", label: "Payroll History", icon: <History className="size-3.5" /> },
  { key: "settings", label: "Settings", icon: <Settings className="size-3.5" /> },
];

const REVIEW_TONE: Record<ReviewStatus | "NO_DATA", string> = {
  READY: "text-positive border-positive/40 bg-positive/10",
  REQUIRES_REVIEW: "text-attention border-attention/40 bg-attention/10",
  BLOCKED: "text-critical border-critical/40 bg-critical/10",
  NO_DATA: "text-meta border-border bg-[var(--row)]",
};
const REVIEW_LABEL: Record<ReviewStatus | "NO_DATA", string> = {
  READY: "Ready", REQUIRES_REVIEW: "Requires review", BLOCKED: "Blocked", NO_DATA: "No data",
};

const money = (n: number | null, cur = "USD"): string => {
  if (n == null) return "—";
  const sym = cur === "EUR" ? "€" : cur === "GBP" ? "£" : "$";
  return sym + Math.round(n).toLocaleString("en-US");
};
const hrs = (n: number | null): string => (n == null ? "—" : `${n.toLocaleString("en-US")} h`);

const SEV_TONE: Record<ExceptionSeverity, string> = {
  CRITICAL: "text-critical bg-critical/15", HIGH: "text-attention bg-attention/15",
  MEDIUM: "text-secondary-text bg-[var(--row)]", LOW: "text-meta bg-[var(--row)]",
};

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ tab?: string; period?: string }> }): Promise<React.JSX.Element> {
  if (!canManagePayroll(await viewerRole())) redirect("/");
  const sp = await searchParams;
  const tab: Tab = (TABS.some((t) => t.key === sp.tab) ? sp.tab : "overview") as Tab;
  const which: "current" | "previous" = sp.period === "previous" ? "previous" : "current";

  const today = await safeToday();
  const period = namedPeriod(today, which);
  const tabHref = (t: Tab): string => `/payroll?tab=${t}${which === "previous" ? "&period=previous" : ""}`;

  return (
    <main className="mx-auto max-w-[1400px] p-3 pb-10 leading-[1.3] md:p-4">
      {/* Header */}
      <header className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight"><Wallet className="size-5 text-meta" /> HR / Payroll</h1>
          <p className="mt-1 flex items-center gap-2 text-[12.5px] text-meta">
            <span className="inline-flex items-center gap-1.5"><Boxes className="size-3.5" /> Connecteam</span>
            <ArrowRight className="size-3" />
            <span className="inline-flex items-center gap-1.5">Zoe reconcile</span>
            <ArrowRight className="size-3" />
            <span className="inline-flex items-center gap-1.5">Gusto</span>
            <span className="ml-1 text-tertiary-text">· pay period {period.label}</span>
          </p>
        </div>
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-[var(--panel)] p-0.5 text-[12px]">
          {(["current", "previous"] as const).map((w) => (
            <Link key={w} href={`/payroll?tab=${tab}${w === "previous" ? "&period=previous" : ""}`}
              className={`rounded px-2.5 py-1 transition-colors ${which === w ? "bg-foreground/[0.08] text-foreground" : "text-meta hover:text-foreground"}`}>
              {w === "current" ? "This week" : "Last week"}
            </Link>
          ))}
        </div>
      </header>

      {/* Tabs */}
      <nav className="mb-4 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link key={t.key} href={tabHref(t.key)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12.5px] font-medium transition-colors ${
              tab === t.key ? "border-foreground text-foreground" : "border-transparent text-meta hover:text-foreground"
            }`}>
            {t.icon} {t.label}
          </Link>
        ))}
      </nav>

      {tab === "overview" && <OverviewTab period={period} which={which} />}
      {tab === "review" && <ReviewTab period={period} which={which} />}
      {tab === "sync" && <SyncTab period={period} which={which} />}
      {tab === "workers" && <WorkersTab period={period} mode="all" />}
      {tab === "contractors" && <WorkersTab period={period} mode="contractors" />}
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

// ── Overview (Payroll Command Center) ────────────────────────────────────────────────────────────────
// The one question it answers: "Can I approve payroll?" Status comes from the deterministic review
// classification; blockers / exceptions / missing-config are shown distinctly (never conflated).
async function OverviewTab({ period, which }: { period: { start: string; end: string; label: string }; which: "current" | "previous" }): Promise<React.JSX.Element> {
  const o = await payrollOverview(period);
  const r = o.review;
  const ready = r.status === "READY";
  const msg =
    r.status === "NO_DATA" ? "Connecteam time source unavailable — pull hours to begin."
      : r.status === "BLOCKED" ? `${r.blocked} worker${r.blocked === 1 ? "" : "s"} blocked (${r.blockingIssues} blocking issue${r.blockingIssues === 1 ? "" : "s"}). Resolve before approving.`
        : r.status === "REQUIRES_REVIEW" ? `${r.requiresReview} worker${r.requiresReview === 1 ? "" : "s"} need review. ${r.ready} ready to approve.`
          : `All ${r.ready} worker${r.ready === 1 ? "" : "s"} ready. Review and approve.`;
  return (
    <div className="space-y-4">
      {/* Status + actions — "Can I approve payroll?" */}
      <section className="surface flex flex-wrap items-center justify-between gap-4 border p-4">
        <div>
          <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.1em] text-meta">
            Payroll status
            {o.approvalStatus && <span className="rounded bg-[var(--row)] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-normal text-tertiary-text">{APPROVAL_STATUS_LABEL[o.approvalStatus]}</span>}
          </div>
          <div className={`mt-1.5 inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-[13px] font-semibold ${REVIEW_TONE[r.status]}`}>
            {ready ? <CheckCircle2 className="size-4" /> : r.status === "BLOCKED" ? <Ban className="size-4" /> : <CircleAlert className="size-4" />}
            {REVIEW_LABEL[r.status]}
          </div>
          <div className="mt-2 text-[12px] text-meta">{msg}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px] text-meta">
            <span>{r.workers} workers</span><span>{hrs(r.hours)}</span>
            <span className="text-positive">{r.ready} ready</span>
            <span className="text-attention">{r.requiresReview} review</span>
            <span className="text-critical">{r.blocked} blocked</span>
          </div>
        </div>
        <div className="flex items-end gap-3">
          <Link href={`/payroll?tab=review${which === "previous" ? "&period=previous" : ""}`}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90">
            <ClipboardCheck className="size-4" /> Review Payroll
          </Link>
          <SyncButton which={which} label="Sync Hours" variant="secondary" />
        </div>
      </section>

      {/* Metrics — status first, then the blocker/exception/config taxonomy kept distinct (§3) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Metric label="Pay period" value={period.label} sub={`${period.start} → ${period.end}`} />
        <Metric label="Total hours" value={hrs(r.hours)} sub={o.connecteamOk ? "actual · from Connecteam" : "source unavailable"} tone={o.connecteamOk ? undefined : "warn"} />
        <Metric label="Est. ready payroll" value={money(r.estReady)} sub={`${r.ready} ready worker${r.ready === 1 ? "" : "s"}`} />
        <Metric label="Est. blocked payroll" value={money(r.estBlocked)} sub={`${r.blocked} blocked`} tone={r.blocked > 0 ? "warn" : undefined} />
        <Metric label="Blocking issues" value={String(r.blockingIssues)} sub="prevent approval" tone={r.blockingIssues > 0 ? "warn" : undefined} />
        <Metric label="Exceptions" value={String(r.exceptions)} sub="anomalies to review" tone={r.exceptions > 0 ? "warn" : undefined} />
        <Metric label="Missing config" value={String(r.missingConfig)} sub="setup incomplete" tone={r.missingConfig > 0 ? "warn" : undefined} />
        <Metric label="Workers" value={String(o.workers)} sub={`${o.employees} employees · ${o.contractors} contractors`} />
        <Metric label="Last sync" value={o.lastSync ? relTime(o.lastSync.at) : "never"} sub={o.lastSync ? `${o.lastSync.status.toLowerCase().replace(/_/g, " ")} · ${o.lastSync.trigger}` : "run a sync to start"} />
        <Metric label="Next automatic sync" value={o.nextAutomaticSync ?? "not scheduled"} sub={o.nextAutomaticSync ? "auto-sync on" : "enable in Settings"} />
        <Metric label="Gusto" value={o.gustoConfigured ? "connected" : "not connected"} sub="payroll destination" tone={o.gustoConfigured ? undefined : "warn"} />
        <Metric
          label="Temp labor (Instawork)"
          value={money(o.tempLabor.amount)}
          sub={o.tempLabor.basis === "actual" ? "actual · paid via Instawork" : o.tempLabor.basis === "estimated" ? "estimated · paid via Instawork" : "no temp gigs this period"}
        />
      </div>
    </div>
  );
}

// ── Payroll Review (the human checkpoint) ────────────────────────────────────────────────────────────
async function ReviewTab({ period, which }: { period: { start: string; end: string; label: string }; which: "current" | "previous" }): Promise<React.JSX.Element> {
  const r = await payrollReview(period);
  const approval = getApproval(period.start, period.end);
  if (r.status === "NO_DATA") {
    return <EmptyState icon={<ClipboardCheck className="size-5" />} title="Nothing to review yet" body="No worker hours for this period (or Connecteam is unavailable). Run a sync to pull hours, then review." />;
  }
  return (
    <div className="space-y-4">
      <section className="surface flex flex-wrap items-center justify-between gap-4 border p-4">
        <div>
          <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.1em] text-meta">
            Review · {period.label}
            {approval && <span className="rounded bg-[var(--row)] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-normal text-tertiary-text">{APPROVAL_STATUS_LABEL[approval.status]}{approval.approvedBy ? ` · ${approval.approvedBy}` : ""}</span>}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[12.5px]">
            <span className="text-foreground">{r.counts.workers} workers · {hrs(r.hours)}</span>
            <span className="text-positive">{r.counts.ready} ready · {money(r.estReadyPayroll)}</span>
            <span className="text-attention">{r.counts.review} review</span>
            <span className="text-critical">{r.counts.blocked} blocked · {money(r.estBlockedPayroll)}</span>
          </div>
        </div>
        <ApproveButton which={which} readyCount={r.counts.ready} />
      </section>

      <ReviewGroup title="Blocked" tone="critical" rows={r.blocked} note="A blocking issue prevents payroll — resolve before approving." />
      <ReviewGroup title="Requires review" tone="attention" rows={r.review} note="Anomalies or incomplete config — review, then they become ready." />
      <ReviewGroup title="Ready" tone="positive" rows={r.ready} note="Clean records, eligible for approval." />
    </div>
  );
}

function ReviewGroup({ title, tone, rows, note }: { title: string; tone: "critical" | "attention" | "positive"; rows: ReviewWorker[]; note: string }): React.JSX.Element {
  const dot = tone === "critical" ? "bg-critical" : tone === "attention" ? "bg-attention" : "bg-positive";
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className={`size-2 rounded-full ${dot}`} />
        <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">{title} <span className="text-meta">({rows.length})</span></h3>
        <span className="text-[11px] text-meta">— {note}</span>
      </div>
      {rows.length === 0 ? (
        <p className="pl-4 text-[12px] text-meta">None.</p>
      ) : (
        <div className="surface overflow-x-auto border">
          <table className="w-full min-w-[820px] text-[12.5px]">
            <thead>
              <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
                <th className="px-3 py-2 font-medium">Worker</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 text-right font-medium">Hours</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
                <th className="px-3 py-2 text-right font-medium">Est. pay</th>
                <th className="px-3 py-2 font-medium">Gusto</th>
                <th className="px-3 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.key} className="border-b border-rule/60 last:border-0 hover:bg-[var(--row-hover)]">
                  <td className="px-3 py-2 font-medium text-foreground">{w.name}</td>
                  <td className="px-3 py-2 text-tertiary-text">{WORKER_TYPE_LABEL[w.workerType]}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{w.hours == null ? "—" : w.hours.toLocaleString("en-US")}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{w.payRate != null ? `${money(w.payRate, w.currency)}/hr` : <span className="text-attention">missing</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-secondary-text">{money(w.estPay, w.currency)}</td>
                  <td className="px-3 py-2"><span className={w.mappingStatus === "UNMATCHED" ? "text-attention" : "text-secondary-text"}>{MAPPING_STATUS_LABEL[w.mappingStatus]}</span></td>
                  <td className="px-3 py-2">
                    {w.issues.length === 0 ? <span className="text-positive">—</span> : (
                      <span className="flex flex-wrap gap-1">
                        {w.issues.map((i) => (
                          <span key={i.code} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${i.kind === "BLOCKING" ? "bg-critical/15 text-critical" : i.kind === "EXCEPTION" ? "bg-attention/15 text-attention" : "bg-[var(--row)] text-meta"}`}>{i.label}</span>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Time Sync (the pipeline) ─────────────────────────────────────────────────────────────────────────
async function SyncTab({ period, which }: { period: { start: string; end: string; label: string }; which: "current" | "previous" }): Promise<React.JSX.Element> {
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
    { label: "Approval", value: r.status === "READY" ? "eligible" : "pending review", state: r.status === "READY" ? "ok" : "idle" },
    { label: "Gusto push", value: "disabled (connect Gusto)", state: "idle" },
  ];
  const dot = (s: "ok" | "warn" | "idle") => (s === "ok" ? "bg-positive" : s === "warn" ? "bg-attention" : "bg-[var(--bar)]");

  return (
    <div className="max-w-2xl space-y-4">
      <section className="surface border p-4">
        <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-3 text-[12.5px]">
          <Field label="Source" value="Connecteam" sub={connecteamConfigured() ? "connected" : "not connected"} />
          <Field label="Destination" value="Gusto" sub={gustoConfigured() ? "connected" : "not connected (push disabled)"} />
          <Field label="Pay period" value={period.label} sub={which === "current" ? "this week" : "last week"} />
          <Field label="Normalized records" value={String(records)} sub="time entries stored" />
        </div>
        <div className="border-t border-rule pt-3">
          <div className="mb-2 text-[10.5px] uppercase tracking-[0.08em] text-meta">Pipeline · {period.label}</div>
          <ol className="space-y-0">
            {stages.map((s, i) => (
              <li key={s.label} className="flex items-center gap-3 py-1.5">
                <span className={`size-2 shrink-0 rounded-full ${dot(s.state)}`} />
                <span className="w-40 shrink-0 text-[12.5px] text-secondary-text">{i + 1}. {s.label}</span>
                <span className={`text-[12.5px] tabular-nums ${s.state === "warn" ? "text-attention" : "text-foreground"}`}>{s.value}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="mt-4 flex items-center gap-3 border-t border-rule pt-4">
          <SyncButton which={which} label="Sync Now" variant="primary" />
          <p className="text-[11.5px] text-meta">
            Pulls Connecteam hours, normalizes + matches workers, reconciles and flags blockers/exceptions. Idempotent — running twice never duplicates hours.{last ? ` Last run ${relTime(last.finishedAt ?? last.startedAt)} · ${last.status.toLowerCase().replace(/_/g, " ")}.` : ""} Gusto push runs only after approval.
          </p>
        </div>
      </section>
    </div>
  );
}

// ── Workers / Contractors ──────────────────────────────────────────────────────────────────────────
async function WorkersTab({ period, mode }: { period: { start: string; end: string; label: string }; mode: "all" | "contractors" }): Promise<React.JSX.Element> {
  const { workers, connecteamOk } = await unifiedWorkers(period);
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
        <WorkerGroup title="US contractors" workers={us} />
        <WorkerGroup title="International contractors" workers={intl} />
        <TempPaySection period={period} />
      </div>
    );
  }
  return <WorkerTable workers={filtered} />;
}

// Instawork temps — a labor-cost view, paid via Instawork (not Gusto). Estimate from booked gigs now,
// with an Actual column that fills once Instawork payouts are imported (the reconcile seam).
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
                <td className="px-3 py-2"></td>
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

function WorkerGroup({ title, workers }: { title: string; workers: UnifiedWorker[] }): React.JSX.Element {
  return (
    <div>
      <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">{title} <span className="text-meta">({workers.length})</span></h3>
      {workers.length === 0 ? <p className="text-[12px] text-meta">None.</p> : <WorkerTable workers={workers} />}
    </div>
  );
}

function WorkerTable({ workers }: { workers: UnifiedWorker[] }): React.JSX.Element {
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
              <td className="px-3 py-2">
                <span className={w.active ? "text-positive" : "text-meta"}>{w.active ? "Active" : "Inactive"}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Exceptions ───────────────────────────────────────────────────────────────────────────────────────
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
        </div>
      ))}
    </div>
  );
}

// ── History ──────────────────────────────────────────────────────────────────────────────────────────
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

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────
function SettingsTab(): React.JSX.Element {
  const ctOk = connecteamConfigured();
  const guOk = gustoConfigured();
  const cfg = getPayrollConfig();
  return (
    <div className="max-w-2xl space-y-3">
      <section className="surface border p-4">
        <h3 className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">Connections</h3>
        <div className="space-y-2.5 text-[12.5px]">
          <ConnRow name="Connecteam" role="Operational time source of truth" ok={ctOk} detail={ctOk ? "connected (CONNECTEAM_API_KEY set)" : "not connected"} />
          <ConnRow name="Gusto" role="Payroll system of record — browser tab-replay (Auto-Pull extension)" ok={guOk} detail={guOk ? "connected — pull landed" : "not connected — open Gusto in the office browser (Auto-Pull extension)"} />
        </div>
      </section>
      <PayrollSettingsForm initial={cfg} />
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────────────────────────────
function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" }): React.JSX.Element {
  return (
    <div className="surface border p-3">
      <div className="text-[10px] uppercase tracking-[0.1em] text-meta">{label}</div>
      <div className={`mt-1.5 text-[18px] font-semibold tabular-nums leading-tight ${tone === "warn" ? "text-attention" : "text-foreground"}`}>{value}</div>
      {sub && <div className="mt-1 truncate text-[11px] text-meta">{sub}</div>}
    </div>
  );
}
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
        <span className={`size-2 rounded-full ${ok ? "bg-positive" : "bg-attention"}`} />
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

function relTime(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "—";
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
