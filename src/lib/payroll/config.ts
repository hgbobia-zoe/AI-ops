// HR / Payroll configuration — the team-editable policy that drives the engine + scheduler. Persisted in
// the settings KV (namespaced), with safe env-free defaults, so behavior is unchanged until someone edits
// it in HR → Settings. Nothing here is hard-coded into business logic (spec §12): the engine reads these.

import { getJson, setJson } from "@/lib/kv";

export interface PayrollConfig {
  payPeriod: "weekly" | "biweekly"; // cadence (period math is weekly today; biweekly is stored for next)
  autoSyncEnabled: boolean; // the scheduled Monday run on/off
  syncDay: number; // 0=Sun … 6=Sat (default Monday)
  syncHour: number; // 0–23, local ET (default 8am)
  approvalPolicy: "always_require" | "auto_if_clean"; // never auto-approve unless explicitly set
  overtimeThreshold: number; // weekly hours above which overtime is flagged (EXCEPTION)
  rateWriteback: boolean; // when a Gusto pull syncs rates, also write them back into Connecteam (PUT)
  // ── Payroll-readiness pre-check (prepares Lisa for the Tuesday payroll run) ──
  precheckEnabled: boolean; // the scheduled readiness pre-check + Slack summary on/off
  payrollDay: number; // the day payroll is RUN (0=Sun … 6=Sat; default Tuesday) — the deadline
  payrollHour: number; // 0–23 ET the payroll run happens (the readiness deadline; default 9am)
  precheckDay: number; // the day the readiness pre-check runs ahead of payroll (default Monday)
  precheckHour: number; // 0–23 ET the pre-check runs (default 8am)
  scheduleDiscrepancyPct: number; // |actual−planned|/planned ≥ this % flags a schedule discrepancy (default 25)
  slackChannel: string | null; // dedicated payroll Slack channel NAME/ID; null = resolve from env/none (never hard-coded)
}

const KEY = "payroll.config";
export const DEFAULT_PAYROLL_CONFIG: PayrollConfig = {
  payPeriod: "weekly",
  autoSyncEnabled: false,
  syncDay: 1,
  syncHour: 8,
  approvalPolicy: "always_require",
  overtimeThreshold: 40,
  rateWriteback: true,
  precheckEnabled: false,
  payrollDay: 2, // Tuesday
  payrollHour: 9,
  precheckDay: 1, // Monday — a day of lead time to resolve exceptions before Tuesday
  precheckHour: 8,
  scheduleDiscrepancyPct: 25,
  slackChannel: null,
};

export const DOW_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function getPayrollConfig(): PayrollConfig {
  return { ...DEFAULT_PAYROLL_CONFIG, ...getJson<Partial<PayrollConfig>>(KEY, {}) };
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}

export function savePayrollConfig(patch: Partial<PayrollConfig>): PayrollConfig {
  const cur = getPayrollConfig();
  const next: PayrollConfig = {
    payPeriod: patch.payPeriod === "biweekly" || patch.payPeriod === "weekly" ? patch.payPeriod : cur.payPeriod,
    autoSyncEnabled: typeof patch.autoSyncEnabled === "boolean" ? patch.autoSyncEnabled : cur.autoSyncEnabled,
    syncDay: clampInt(patch.syncDay, 0, 6, cur.syncDay),
    syncHour: clampInt(patch.syncHour, 0, 23, cur.syncHour),
    approvalPolicy: patch.approvalPolicy === "auto_if_clean" || patch.approvalPolicy === "always_require" ? patch.approvalPolicy : cur.approvalPolicy,
    overtimeThreshold: clampInt(patch.overtimeThreshold, 1, 168, cur.overtimeThreshold),
    rateWriteback: typeof patch.rateWriteback === "boolean" ? patch.rateWriteback : cur.rateWriteback,
    precheckEnabled: typeof patch.precheckEnabled === "boolean" ? patch.precheckEnabled : cur.precheckEnabled,
    payrollDay: clampInt(patch.payrollDay, 0, 6, cur.payrollDay),
    payrollHour: clampInt(patch.payrollHour, 0, 23, cur.payrollHour),
    precheckDay: clampInt(patch.precheckDay, 0, 6, cur.precheckDay),
    precheckHour: clampInt(patch.precheckHour, 0, 23, cur.precheckHour),
    scheduleDiscrepancyPct: clampInt(patch.scheduleDiscrepancyPct, 1, 100, cur.scheduleDiscrepancyPct),
    slackChannel: patch.slackChannel === undefined ? cur.slackChannel : (patch.slackChannel?.toString().trim() || null),
  };
  setJson(KEY, next);
  return next;
}

function hour12(h: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:00 ${ampm}`;
}

/** "Mondays at 8:00 AM" — the recurring schedule, for display. */
export function scheduleLabel(cfg: PayrollConfig = getPayrollConfig()): string {
  return `${DOW_LABEL[cfg.syncDay]}s at ${hour12(cfg.syncHour)} ET`;
}

/** "Mondays at 8:00 AM" — the readiness pre-check cadence, for display. */
export function precheckScheduleLabel(cfg: PayrollConfig = getPayrollConfig()): string {
  return `${DOW_LABEL[cfg.precheckDay]}s at ${hour12(cfg.precheckHour)} ET`;
}

/** "Tuesdays at 9:00 AM" — the payroll-run deadline, for display. */
export function payrollDeadlineLabel(cfg: PayrollConfig = getPayrollConfig()): string {
  return `${DOW_LABEL[cfg.payrollDay]}s at ${hour12(cfg.payrollHour)} ET`;
}
