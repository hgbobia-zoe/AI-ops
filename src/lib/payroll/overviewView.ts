// Everything Payroll Overview shows, derived from the SAME readiness model Payroll Review uses (plus the sync
// and Gusto ledgers). Pure, so each state the page can be in is fixture-tested. Overview never submits: every
// action here is a link to an existing workflow (or the existing hours sync).
//
// Readiness rules used (from readinessModel + runReadiness, in this order):
//   1. Connecteam unreachable → sync hours first (nothing else can be verified).
//   2. Any worker in the run BLOCKED (e.g. not linked to Gusto) → resolve the blockers first. A blocker beats
//      the same worker's unapproved timesheet: approving a worker who can't be paid doesn't unblock the run.
//   3. Otherwise the model's next action (review / approve timesheets), and once the run is clean, Payroll
//      Review, where Run payroll and the final submit live.

import type { PayrollReadinessModel, PayrollTone, SyncStatus, UnifiedIssueSeverity } from "./types";
import { runReadiness, type RunReadiness } from "./runReadiness";
import { draftAttemptLine, submitAttemptLine, type AttemptLine } from "./attemptText";

export interface OverviewLedgers {
  lastSync: { status: SyncStatus; at: string | null; periodStart: string; periodEnd: string; reviewCount: number | null } | null;
  lastPush: { at: string; ok: boolean; aborted: string | null; pushed: number; failed: number; skipped: number; periodStart: string | null; periodEnd: string | null } | null;
  lastSubmit: { at: string; ok: boolean; aborted: string | null; submitted: boolean; alreadySubmitted: boolean; errors: { message: string }[] } | null;
}

export type OverviewAction =
  | { kind: "sync"; label: string; explain: string }
  | { kind: "link"; label: string; href: string; explain: string };

export interface OverviewIssue {
  code: string;
  severity: UnifiedIssueSeverity;
  title: string;
  count: number;
  workers: string[];
  action: { label: string; href: string | null };
  detail: string;
}

export interface OverviewView {
  run: RunReadiness;
  action: OverviewAction;
  issues: OverviewIssue[];
  affectedWorkers: number; // deduped across overlapping issues
  approval: {
    zoeApproved: number;
    signOff: { by: string | null; at: string | null } | null; // the period-level Zoe sign-off event
    ctApproved: number; // workers with all their time approved in Connecteam
    ctUnapproved: number; // workers with unapproved time in Connecteam
    ctLocked: number; // workers whose days were locked in Connecteam by the Zoe approval
    included: number;
  };
  sync: { at: string | null; status: SyncStatus | null; text: string; explain: string | null; forThisPeriod: boolean };
  summary: {
    included: number;
    recordedHours: number | null;
    ctApprovedHours: number | null;
    estGross: number | null;
    estCoverage: { known: number; total: number }; // workers with hours whose rate is known, of all with hours
  };
  attempt: (AttemptLine & { at: string }) | null;
  showChecklist: boolean;
  showSources: boolean;
}

const SEV_RANK: Record<UnifiedIssueSeverity, number> = { blocker: 0, review: 1, unverified: 2, setup: 3 };

function withPeriod(href: string, periodQS: string): string {
  if (!periodQS) return href;
  return href.includes("?") ? `${href}${periodQS}` : `${href}?${periodQS.replace(/^&/, "")}`;
}

function blockerAction(code: string, count: number): string {
  const s = count === 1 ? "" : "s";
  if (code === "NO_GUSTO_MAPPING") return `Resolve ${count} Gusto mapping${s}`;
  if (code === "DUPLICATE_GUSTO_MAPPING") return `Fix ${count} duplicate Gusto mapping${s}`;
  return `Resolve ${count} blocker${s}`;
}

const SYNC_TEXT: Record<SyncStatus, string> = {
  RUNNING: "Sync running",
  READY: "Synced",
  SYNCED: "Synced",
  REQUIRES_REVIEW: "Synced, with workers to review",
  FAILED: "Last sync failed",
};

export function buildOverviewView(m: PayrollReadinessModel, ledgers: OverviewLedgers, periodQS = ""): OverviewView {
  const run = runReadiness(m);
  const inRunKeys = new Set(m.workers.map((w) => w.key));

  // Issues straight from the model's attention groups (same as Review), worst first; the overall count is
  // deduped because one worker can carry several issues (e.g. not linked AND timesheet not approved).
  const issues: OverviewIssue[] = [...m.attention]
    .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count)
    .map((g) => ({
      code: g.code, severity: g.severity, title: g.title, count: g.count,
      workers: g.workers.map((w) => w.name),
      action: { label: g.action.label, href: g.action.href ? withPeriod(g.action.href, periodQS) : null },
      detail: g.detail,
    }));
  const affected = new Set<string>();
  for (const g of m.attention) if (g.severity !== "setup") for (const w of g.workers) affected.add(w.key);

  // The one primary action (rules 1-3 above).
  const reviewHref = withPeriod("/payroll?tab=review", periodQS);
  let action: OverviewAction;
  const topBlocker = m.attention
    .filter((g) => g.severity === "blocker" && g.workers.some((w) => inRunKeys.has(w.key)))
    .sort((a, b) => b.count - a.count)[0];
  if (!m.connecteamOk) {
    action = { kind: "sync", label: "Sync hours", explain: "Connecteam is unreachable. Retry the hours sync first." };
  } else if (run.blocked > 0 && topBlocker) {
    action = {
      kind: "link",
      label: blockerAction(topBlocker.code, topBlocker.count),
      href: withPeriod(topBlocker.action.href ?? reviewHref, periodQS),
      explain: "Blocked workers can't be paid until they're fixed or excluded. Do this before approving their timesheets.",
    };
  } else if (run.label === "Ready") {
    action = { kind: "link", label: "Open payroll review", href: reviewHref, explain: "Run payroll and the final submit happen in Payroll Review." };
  } else {
    const na = m.nextAction;
    action = na.href
      ? { kind: "link", label: na.label, href: withPeriod(na.href, periodQS), explain: na.explain }
      : { kind: "link", label: "Open payroll review", href: reviewHref, explain: na.explain };
  }

  // Approval facts, kept apart: the Zoe sign-off, Connecteam's own timesheet approval, and the Connecteam lock.
  const zoeApproved = m.workers.filter((w) => w.approvalState === "APPROVED_IN_ZOE").length;
  const ctUnapproved = m.workers.filter((w) => (w.unapprovedHours ?? 0) > 0).length;
  const ctApproved = m.workers.filter((w) => w.approvalState === "APPROVED" || (w.unapprovedHours === 0 && (w.approvedHours ?? 0) > 0)).length;
  const ctLocked = m.workers.filter((w) => w.ctLockStatus === "LOCKED").length;
  const signOff = m.approval?.status === "APPROVED" ? { by: m.approval.approvedBy ?? null, at: m.approval.approvedAt ?? null } : null;

  // Sync: when the last sync for THIS period ran, what it reported, and what "requires review" means.
  const ls = ledgers.lastSync;
  const forThisPeriod = !!ls && ls.periodStart === m.period.start && ls.periodEnd === m.period.end;
  const sync = !ls
    ? { at: null, status: null, text: "Never synced", explain: "Sync hours to pull this period from Connecteam.", forThisPeriod: false }
    : {
        at: ls.at,
        status: ls.status,
        text: SYNC_TEXT[ls.status],
        explain: ls.status === "REQUIRES_REVIEW"
          ? `The sync finished. It flagged ${ls.reviewCount ?? "some"} worker${ls.reviewCount === 1 ? "" : "s"} for review, which is about the hours, not a failed sync.`
          : ls.status === "FAILED" ? "Retry the hours sync." : null,
        forThisPeriod,
      };

  // Summary, each figure scoped to the workers in this run.
  const withHours = m.workers.filter((w) => (w.hours ?? 0) > 0);
  const summary = {
    included: m.counts.included,
    recordedHours: m.totals.hours,
    ctApprovedHours: m.totals.approvedHours,
    estGross: m.totals.estGross,
    estCoverage: { known: withHours.filter((w) => w.estPay != null).length, total: withHours.length },
  };

  // Latest Gusto attempt for THIS period: a draft update or a submit, whichever came last.
  const samePeriod = (s: string | null, e: string | null): boolean => s === m.period.start && e === m.period.end;
  const candidates: (AttemptLine & { at: string })[] = [];
  if (ledgers.lastPush && samePeriod(ledgers.lastPush.periodStart, ledgers.lastPush.periodEnd)) {
    candidates.push({ ...draftAttemptLine(ledgers.lastPush), at: ledgers.lastPush.at });
  }
  if (ledgers.lastSubmit) candidates.push({ ...submitAttemptLine(ledgers.lastSubmit), at: ledgers.lastSubmit.at });
  const attempt = candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;

  const showChecklist = m.gates.some((g) => g.state === "UNAVAILABLE") || (run.blocked > 0 && m.gates.some((g) => g.state === "BLOCKED"));
  const showSources = m.sources.some((s) => s.key !== "instawork" && (s.state === "unavailable" || s.state === "stale"));

  return {
    run, action, issues, affectedWorkers: affected.size,
    approval: { zoeApproved, signOff, ctApproved, ctUnapproved, ctLocked, included: m.counts.included },
    sync, summary, attempt, showChecklist, showSources,
  };
}

export const TONE_TEXT: Record<PayrollTone, string> = {
  positive: "text-positive", attention: "text-attention", critical: "text-critical", neutral: "text-meta",
};
