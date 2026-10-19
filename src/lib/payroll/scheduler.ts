// Scheduled payroll sync (spec §13). Runs on the cloud runtime tick; the SAME engine as manual Sync Now
// (runPayrollSync) — no second implementation. It fires once per week, on the configured day/hour (ET),
// for the just-completed pay period: pull → normalize → match → reconcile → create the Payroll Review →
// notify. It NEVER auto-pushes to Gusto; it only auto-APPROVES when the period is clean AND the policy is
// explicitly set to auto_if_clean (default is always_require → a human approves). Idempotent per period.

import { connecteamConfigured } from "@/lib/connecteam";
import { getJson, setJson } from "@/lib/kv";
import { slackNotify } from "@/lib/notify/slack";
import { getPayrollConfig, DOW_LABEL } from "./config";
import { previousPayPeriod } from "./period";
import { runPayrollSync } from "./sync";
import { payrollReview } from "./review";
import { assessReadiness, persistReadinessExceptions } from "./readiness";
import { postPayrollReadiness } from "./slack";
import { upsertApproval } from "./store";

const LAST_KEY = "payroll.lastScheduledPeriod";
const PRECHECK_LAST_KEY = "payroll.lastPrecheck"; // { "<phase>": "<periodKey>" } — once per phase per period

/** ET calendar parts for "is it time?" — the runtime runs in UTC, but the schedule is in ops (ET) time. */
function etNow(now: Date = new Date()): { ymd: string; dow: number; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const dowMap: Record<string, number> = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, dow: dowMap[parts.weekday] ?? 1, hour: Number(parts.hour) };
}

export interface ScheduledResult {
  ran: boolean;
  detail: string;
}

export async function runScheduledPayrollSyncIfDue(now: Date = new Date()): Promise<ScheduledResult> {
  const cfg = getPayrollConfig();
  if (!cfg.autoSyncEnabled) return { ran: false, detail: "auto-sync disabled" };
  if (!connecteamConfigured()) return { ran: false, detail: "Connecteam not configured" };

  const { ymd, dow, hour } = etNow(now);
  if (dow !== cfg.syncDay || hour < cfg.syncHour) {
    return { ran: false, detail: `waiting for ${DOW_LABEL[cfg.syncDay]} ${cfg.syncHour}:00 ET` };
  }

  const period = previousPayPeriod(ymd); // the just-completed week
  const key = `${period.start}..${period.end}`;
  if (getJson<string | null>(LAST_KEY, null) === key) return { ran: false, detail: `already ran ${period.label}` };

  const summary = await runPayrollSync({ periodStart: period.start, periodEnd: period.end, trigger: "scheduled", actor: null });
  const rv = await payrollReview(period);

  // Clean + explicit auto policy → auto-approve the ready set; otherwise require a human (default).
  const autoApprove = rv.status === "READY" && cfg.approvalPolicy === "auto_if_clean";
  upsertApproval({
    periodStart: period.start, periodEnd: period.end,
    status: autoApprove ? "APPROVED" : "REVIEW_REQUIRED",
    approvedBy: autoApprove ? "Auto (clean-payroll policy)" : null,
    approvedAt: autoApprove ? new Date().toISOString() : null,
    readyWorkerCount: rv.counts.ready, estApprovedAmount: rv.estReadyPayroll,
    snapshot: { trigger: "scheduled", readyKeys: rv.ready.map((w) => w.key) },
  });
  setJson(LAST_KEY, key);

  void slackNotify(
    `Payroll auto-sync — ${period.label}: ${summary.status}. ${rv.counts.ready} ready, ${rv.counts.review} review, ${rv.counts.blocked} blocked. ` +
      (autoApprove ? "Auto-approved (clean)." : "Review required before approval."),
  );
  return { ran: true, detail: `${period.label}: sync ${summary.status}, review ${autoApprove ? "APPROVED" : "REVIEW_REQUIRED"}` };
}

/**
 * Scheduled payroll-READINESS pre-check (spec Phase 3/5). Runs ahead of the Tuesday payroll deadline (on the
 * configured pre-check day/hour) and again as a final check on payroll day: assess the just-completed week,
 * persist any exceptions into the queue, and post an idempotent readiness summary to the dedicated payroll
 * Slack channel. Gated once per phase per period (Slack content-dedup additionally prevents floods). It is
 * READ-ONLY — it never mutates hours and NEVER submits payroll (Gusto export stays a human action).
 */
export async function runScheduledPrecheckIfDue(now: Date = new Date()): Promise<ScheduledResult> {
  const cfg = getPayrollConfig();
  if (!cfg.precheckEnabled) return { ran: false, detail: "readiness pre-check disabled" };
  if (!connecteamConfigured()) return { ran: false, detail: "Connecteam not configured" };

  const { ymd, dow, hour } = etNow(now);
  const phase: "precheck" | "deadline" | null =
    dow === cfg.precheckDay && hour >= cfg.precheckHour ? "precheck"
      : dow === cfg.payrollDay && hour >= cfg.payrollHour ? "deadline"
        : null;
  if (!phase) {
    return { ran: false, detail: `waiting for ${DOW_LABEL[cfg.precheckDay]} ${cfg.precheckHour}:00 ET (or ${DOW_LABEL[cfg.payrollDay]} ${cfg.payrollHour}:00 ET deadline)` };
  }

  const period = previousPayPeriod(ymd); // the week being paid this Tuesday
  const periodKey = `${period.start}..${period.end}`;
  const last = getJson<Record<string, string>>(PRECHECK_LAST_KEY, {});
  if (last[phase] === periodKey) return { ran: false, detail: `${phase} already ran for ${period.label}` };

  const readiness = await assessReadiness(period);
  persistReadinessExceptions(readiness);
  await postPayrollReadiness(readiness, phase);

  last[phase] = periodKey;
  setJson(PRECHECK_LAST_KEY, last);
  return { ran: true, detail: `${phase} ${period.label}: ${readiness.status} (${readiness.blocking} blocking, ${readiness.anomalies} review, ${readiness.unverified} unverified)` };
}
