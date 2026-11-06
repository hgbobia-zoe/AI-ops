// Payroll Overview: answers, at a glance, can this period proceed, what to do next, and what happened on the
// latest attempt. Presentational: everything comes from buildOverviewView() (the same readiness model as Payroll
// Review). No action here submits payroll; every action links to an existing workflow or runs the hours sync.

import Link from "next/link";
import { ArrowRight, CheckCircle2, ChevronRight, CircleAlert } from "lucide-react";
import { StatusBadge } from "@/components/ui/status";
import { SyncButton } from "@/components/payroll/SyncButton";
import type { PayrollActivityEvent, PayrollGate, PayrollSourceHealth, PayrollTone, PayPeriod } from "@/lib/payroll/types";
import type { OverviewView, OverviewIssue } from "@/lib/payroll/overviewView";

const TONE_TEXT: Record<PayrollTone, string> = { positive: "text-positive", attention: "text-attention", critical: "text-critical", neutral: "text-meta" };
const SEV: Record<OverviewIssue["severity"], { label: string; tone: PayrollTone }> = {
  blocker: { label: "Blocker", tone: "critical" },
  review: { label: "Warning", tone: "attention" },
  unverified: { label: "Unverified", tone: "attention" },
  setup: { label: "Setup", tone: "neutral" },
};
const GATE_STATE: Record<PayrollGate["state"], { label: string; tone: PayrollTone }> = {
  PASS: { label: "Done", tone: "positive" }, ACTION: { label: "Action needed", tone: "attention" }, UNVERIFIED: { label: "Unverified", tone: "attention" },
  BLOCKED: { label: "Blocked", tone: "critical" }, UNAVAILABLE: { label: "Unavailable", tone: "critical" }, PENDING: { label: "Waiting", tone: "neutral" }, NA: { label: "Not needed", tone: "neutral" },
};
const SRC_STATE: Record<PayrollSourceHealth["state"], { label: string; tone: PayrollTone }> = {
  ok: { label: "Current", tone: "positive" }, stale: { label: "Stale", tone: "attention" }, unavailable: { label: "Unavailable", tone: "critical" },
  idle: { label: "No saved data", tone: "neutral" }, off: { label: "Not connected", tone: "neutral" },
};

const usd = (n: number | null): string => (n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const hrs = (n: number | null): string => (n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function rel(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
function day(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
}

export function PayrollOverview({ view, period, gates, sources, schedule, activity }: {
  view: OverviewView;
  period: PayPeriod;
  gates: PayrollGate[];
  sources: PayrollSourceHealth[];
  schedule: { deadlineLabel: string; precheckLabel: string | null; autoSyncLabel: string | null };
  activity: PayrollActivityEvent[];
}): React.JSX.Element {
  const { run, action, issues, approval, sync, summary, attempt } = view;
  const mainIssues = issues.filter((i) => i.severity !== "setup");
  const setupIssues = issues.filter((i) => i.severity === "setup");
  // The attempt card already shows the latest Gusto attempt; the list below it shows the other recent events.
  const otherActivity = activity.filter((e) => !(attempt && e.layer === "submission" && e.label === attempt.title));
  const partial = summary.estCoverage.total > 0 && summary.estCoverage.known < summary.estCoverage.total;

  return (
    <div className="flex flex-col gap-4">
      {/* 1 · Can this period proceed, and the one next action. Blockers and warnings right below. */}
      <section className="surface border" aria-labelledby="ov-status">
        <div className="flex flex-wrap items-start justify-between gap-4 p-4">
          <div className="min-w-0">
            <h2 id="ov-status" className="sr-only">Run status</h2>
            <div className="flex items-center gap-2">
              <StatusBadge tone={run.tone} size="md" className="font-semibold">{run.label}</StatusBadge>
              <span className="text-[11.5px] text-meta">{period.label}</span>
            </div>
            <p className="mt-1.5 max-w-2xl text-[13px] text-secondary-text">{run.text}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            {action.kind === "sync" ? (
              <SyncButton period={period} label={action.label} variant="primary" />
            ) : (
              <Link href={action.href} className="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90">
                {action.label} <ArrowRight className="size-4" aria-hidden />
              </Link>
            )}
            <span className="max-w-[18rem] text-right text-[11px] leading-snug text-meta">{action.explain}</span>
          </div>
        </div>
        {mainIssues.length > 0 ? (
          <div className="border-t border-rule px-4 py-3">
            <p className="mb-2 text-[11.5px] text-meta">
              {view.affectedWorkers} worker{view.affectedWorkers === 1 ? "" : "s"} affected across {mainIssues.length} issue{mainIssues.length === 1 ? "" : "s"} (a worker can have more than one).
            </p>
            <ul className="divide-y divide-[var(--row-rule)]">
              {mainIssues.map((i) => (
                <li key={i.code} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <StatusBadge tone={SEV[i.severity].tone} size="sm">{SEV[i.severity].label}</StatusBadge>
                  <span className="min-w-0 flex-1 text-[12.5px] text-foreground">
                    {i.title} <span className="text-meta">· {i.count} worker{i.count === 1 ? "" : "s"}: {i.workers.join(", ")}</span>
                  </span>
                  {i.action.href
                    ? <Link href={i.action.href} className="shrink-0 rounded border border-border px-2 py-0.5 text-[11.5px] text-secondary-text hover:bg-[var(--row-hover)] hover:text-foreground">{i.action.label}</Link>
                    : <span className="shrink-0 text-[11.5px] text-meta">{i.action.label}</span>}
                </li>
              ))}
            </ul>
          </div>
        ) : run.label !== "Unavailable" && run.label !== "No hours" ? (
          <p className="flex items-center gap-2 border-t border-rule px-4 py-2.5 text-[12.5px] text-positive">
            <CheckCircle2 className="size-4" aria-hidden /> No blockers or warnings for the {summary.included} worker{summary.included === 1 ? "" : "s"} in this run.
          </p>
        ) : null}
      </section>

      {/* 2 · Period summary and the latest attempt, side by side. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="surface border p-4" aria-labelledby="ov-summary">
          <h2 id="ov-summary" className="text-[10.5px] uppercase tracking-[0.1em] text-meta">This period</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Figure label="Workers in run" value={String(summary.included)} sub="included, not excluded" />
            <Figure label="Recorded hours" value={hrs(summary.recordedHours)} sub="in the run · Connecteam" />
            <Figure label="Approved in Connecteam" value={hrs(summary.ctApprovedHours)} sub={summary.ctApprovedHours == null ? "approval not available" : "hours, Connecteam's own approval"} />
            <Figure
              label="Est. gross"
              value={usd(summary.estGross)}
              sub={summary.estGross == null ? "no known rates" : partial ? `Partial estimate · ${summary.estCoverage.known} of ${summary.estCoverage.total} workers` : "hours × rate · Gusto sets actual pay"}
              tone={partial || summary.estGross == null ? "attention" : undefined}
            />
          </dl>
        </section>

        <section className="surface border p-4" aria-labelledby="ov-attempt">
          <div className="flex items-center justify-between gap-2">
            <h2 id="ov-attempt" className="text-[10.5px] uppercase tracking-[0.1em] text-meta">Latest Gusto attempt</h2>
            <Link href="/payroll?tab=history" className="text-[11px] text-meta hover:text-foreground">History →</Link>
          </div>
          {attempt ? (
            <div className="mt-2.5">
              <div className="flex items-center gap-2">
                <StatusBadge tone={attempt.tone} size="sm">{attempt.kind === "draft" ? "Draft update" : "Submit"}</StatusBadge>
                <span className="text-[11px] text-meta">{rel(attempt.at)}</span>
              </div>
              <p className={`mt-1.5 text-[13px] font-medium ${TONE_TEXT[attempt.tone] === "text-meta" ? "text-foreground" : TONE_TEXT[attempt.tone]}`}>
                {attempt.title}{attempt.detail ? <span className="font-normal text-secondary-text"> · {attempt.detail}</span> : null}
              </p>
              <p className="mt-1 text-[11px] text-meta">
                {attempt.kind === "draft" ? "A draft update only writes hours into the Gusto draft. Nothing is paid until payroll is submitted." : "Submitting runs payroll in Gusto. The wire is still sent from Mercury."}
              </p>
            </div>
          ) : (
            <p className="mt-2.5 text-[12px] text-meta">No Gusto draft update or submit for this period yet.</p>
          )}
          {otherActivity.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-rule pt-2.5">
              {otherActivity.slice(0, 4).map((e) => (
                <li key={e.id} className="flex items-center gap-2 text-[11.5px]">
                  <span className={`shrink-0 ${TONE_TEXT[e.tone]}`}>{e.tone === "critical" || e.tone === "attention" ? <CircleAlert className="size-3.5" aria-label="problem" /> : <span className="inline-block size-1.5 rounded-full bg-current align-middle" aria-hidden />}</span>
                  <span className="min-w-0 flex-1 truncate text-secondary-text">{e.label}{e.outcome ? <span className="text-meta"> · {e.outcome}</span> : null}</span>
                  <span className="shrink-0 text-meta">{rel(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 3 · Approval and hours facts, each stated separately so a done step never reads as "run ready". */}
      <section className="surface border p-4" aria-labelledby="ov-facts">
        <h2 id="ov-facts" className="text-[10.5px] uppercase tracking-[0.1em] text-meta">Approval and hours</h2>
        <dl className="mt-2 divide-y divide-[var(--row-rule)] text-[12.5px]">
          <FactRow label="Zoe approval">
            {approval.zoeApproved} of {approval.included} worker{approval.included === 1 ? "" : "s"} approved in Zoe
            {approval.signOff && <span className="text-meta"> · signed off{approval.signOff.by ? ` by ${approval.signOff.by}` : ""}{approval.signOff.at ? ` ${day(approval.signOff.at)}` : ""}</span>}
          </FactRow>
          <FactRow label="Connecteam timesheets" note={approval.zoeApproved > 0 && approval.ctUnapproved > 0 ? "Connecteam's own approval column isn't used for payroll here; the Zoe approval is the sign-off." : undefined}>
            {approval.ctApproved} approved, {approval.ctUnapproved} with unapproved time
          </FactRow>
          <FactRow label="Connecteam lock" note="Approving in Zoe locks the worker's days in Connecteam so they can't be edited.">
            {approval.ctLocked} worker{approval.ctLocked === 1 ? "" : "s"} locked
          </FactRow>
          <FactRow label="Hours sync" note={sync.explain ?? undefined}>
            <span className={sync.status === "FAILED" ? "text-critical" : ""}>{sync.text}</span>
            <span className="text-meta"> · last {rel(sync.at)}{sync.at && !sync.forThisPeriod ? " (a different period)" : ""}</span>
          </FactRow>
        </dl>
      </section>

      {/* 4 · Secondary: schedule + automation, data sources, workflow checklist. Collapsed unless they explain
          a current problem. */}
      <div className="grid gap-3 md:grid-cols-3">
        <Collapsible title="Schedule & automation" summary={schedule.deadlineLabel} open={false}>
          <dl className="space-y-1.5 text-[12px]">
            <Rail label="Payroll runs" value={schedule.deadlineLabel} />
            <Rail label="Pay date" value="Set by Gusto per run" muted />
            <Rail label="Readiness pre-check" value={schedule.precheckLabel ?? "Off"} muted={!schedule.precheckLabel} />
            <Rail label="Auto hours sync" value={schedule.autoSyncLabel ?? "Off"} muted={!schedule.autoSyncLabel} />
          </dl>
          <div className="mt-2 flex flex-wrap gap-3 text-[11.5px]">
            <Link href="/payroll?tab=settings" className="text-tertiary-text hover:text-foreground">Settings →</Link>
            <Link href="/ai-org/employees" className="text-tertiary-text hover:text-foreground">AI Payroll Manager →</Link>
          </div>
        </Collapsible>

        <Collapsible title="Data sources" summary={sources.map((s) => `${s.label} ${(s.key === "instawork" && s.state === "ok" ? "snapshot saved" : SRC_STATE[s.state].label).toLowerCase()}`).join(" · ")} open={view.showSources}>
          <p className="mb-2 text-[11px] text-meta">The saved data payroll uses. The bar at the top of the app shows live sign-in status, which can differ.</p>
          <ul className="space-y-2 text-[12px]">
            {sources.map((s) => (
              <li key={s.key}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{s.label}</span>
                  <StatusBadge tone={SRC_STATE[s.state].tone} size="sm">{s.key === "instawork" && s.state === "ok" ? "Snapshot saved" : SRC_STATE[s.state].label}</StatusBadge>
                </div>
                <div className="text-[11px] text-meta">{s.role} · {s.detail}{s.lastAt ? ` · saved ${rel(s.lastAt)}` : ""}</div>
              </li>
            ))}
          </ul>
        </Collapsible>

        <Collapsible title="Workflow checklist" summary={`${gates.filter((g) => g.state === "PASS").length} of ${gates.length} steps done`} open={view.showChecklist}>
          <ol className="space-y-1.5 text-[12px]">
            {gates.map((g) => (
              <li key={g.key} className="flex items-start justify-between gap-2">
                <span className="text-secondary-text">{g.label}<span className="block text-[11px] text-meta">{g.detail}</span></span>
                <StatusBadge tone={GATE_STATE[g.state].tone} size="sm">{GATE_STATE[g.state].label}</StatusBadge>
              </li>
            ))}
          </ol>
          {setupIssues.length > 0 && (
            <p className="mt-2 border-t border-rule pt-2 text-[11px] text-meta">Setup notes (don&apos;t block the run): {setupIssues.map((i) => `${i.title} (${i.count})`).join(", ")}</p>
          )}
        </Collapsible>
      </div>
    </div>
  );
}

function Figure({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "attention" }): React.JSX.Element {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.08em] text-meta">{label}</dt>
      <dd className={`mt-1 text-[18px] font-semibold tabular-nums leading-tight ${tone === "attention" ? "text-attention" : "text-foreground"}`}>{value}</dd>
      <dd className={`mt-0.5 text-[10.5px] ${tone === "attention" ? "text-attention" : "text-meta"}`}>{sub}</dd>
    </div>
  );
}

function FactRow({ label, children, note }: { label: string; children: React.ReactNode; note?: string }): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="text-[11.5px] text-meta">{label}</dt>
      <dd className="text-secondary-text">
        {children}
        {note && <div className="mt-0.5 text-[11px] text-meta">{note}</div>}
      </dd>
    </div>
  );
}

function Collapsible({ title, summary, open, children }: { title: string; summary: string; open: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <details className="surface group border" open={open}>
      <summary className="flex cursor-pointer list-none items-start gap-2 px-3.5 py-2.5">
        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-meta transition-transform group-open:rotate-90" aria-hidden />
        <span className="min-w-0">
          <span className="block text-[12px] font-medium text-foreground">{title}</span>
          <span className="block truncate text-[11px] text-meta">{summary}</span>
        </span>
      </summary>
      <div className="border-t border-rule px-3.5 py-3">{children}</div>
    </details>
  );
}

function Rail({ label, value, muted }: { label: string; value: string; muted?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-meta">{label}</dt>
      <dd className={muted ? "text-meta" : "font-medium text-secondary-text"}>{value}</dd>
    </div>
  );
}
