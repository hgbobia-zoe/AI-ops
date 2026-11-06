// The run-level readiness line Payroll Review and Payroll Overview BOTH show, from the same readiness model, so
// the two pages can never disagree. Pure. Blocked beats needs-review beats ready; an unreachable time source
// beats everything (nothing could be checked).

import type { PayrollReadinessModel, PayrollTone } from "./types";

export interface RunReadiness {
  tone: PayrollTone;
  label: "Blocked" | "Needs review" | "Ready" | "Unavailable" | "No hours";
  text: string;
  blocked: number;
  warnings: number;
  contractors: number;
}

export function runReadiness(m: Pick<PayrollReadinessModel, "workers" | "approval" | "connecteamOk" | "counts">): RunReadiness {
  const blocked = m.workers.filter((w) => w.status === "BLOCKED").length;
  const warnings = m.workers.filter((w) => w.status === "ACTION_REQUIRED" || w.status === "UNVERIFIED").length;
  const contractors = m.workers.filter((w) => w.workerType === "US_CONTRACTOR" || w.workerType === "INTERNATIONAL_CONTRACTOR").length;
  const approved = m.approval?.status === "APPROVED";
  const base = { blocked, warnings, contractors };
  if (!m.connecteamOk) {
    return { ...base, tone: "attention", label: "Unavailable", text: "Connecteam is unreachable, so hours can't be checked. Sync hours before relying on this period." };
  }
  if (m.counts.included === 0) {
    return { ...base, tone: "neutral", label: "No hours", text: "No worker logged hours in this completed week. Nothing to pay." };
  }
  if (blocked > 0) {
    return { ...base, tone: "critical", label: "Blocked", text: `${blocked} worker${blocked === 1 ? " is" : "s are"} blocked and won't be sent to Gusto until fixed or excluded.` };
  }
  if (warnings > 0) {
    return { ...base, tone: "attention", label: "Needs review", text: `${warnings} worker${warnings === 1 ? " needs" : "s need"} review before approval.` };
  }
  return {
    ...base,
    tone: "positive",
    label: "Ready",
    text: approved ? "Approved. Ready to run payroll." : "Every worker is ready. Run payroll approves and fills the Gusto draft.",
  };
}
