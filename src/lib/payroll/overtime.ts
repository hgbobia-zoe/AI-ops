// Overtime: ONE rule for the whole payroll flow (sync exceptions, Review, Readiness, the Gusto draft push).
//
// Overtime is owed to HOURLY workers for hours past the weekly threshold (40h in MD, VA and DC, set in Payroll
// settings). Salaried workers (Connecteam pay rate type monthly or yearly) get none. The pay type is read
// from Connecteam (see workers.ts), never assumed: when it is unknown we do not split anything, we flag the
// worker so a person sets the pay type in Connecteam.

import type { PayType } from "./types";

export type OvertimeRule = "hourly" | "salaried" | "unknown";

export function overtimeRule(payType: PayType | null | undefined): OvertimeRule {
  if (payType === "hourly") return "hourly";
  if (payType === "salary" || payType === "fixed") return "salaried";
  return "unknown";
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Split a week's hours into regular + overtime at the threshold. Pure; callers decide whether it applies. */
export function splitOvertime(hours: number, overtimeThreshold: number): { regular: number; overtime: number } {
  const h = Math.max(0, hours);
  const t = Math.max(0, overtimeThreshold);
  if (h <= t) return { regular: round2(h), overtime: 0 };
  return { regular: round2(t), overtime: round2(h - t) };
}

/** What Review / Readiness / the sync should say about a worker's week, or null when there is nothing to flag.
 *  Hourly over the threshold: overtime to review. Unknown pay type over the threshold: set the pay type.
 *  Salaried: never flagged. */
export function overtimeFlag(
  hours: number | null | undefined,
  payType: PayType | null | undefined,
  overtimeThreshold: number,
): { label: string; action: string } | null {
  const h = hours ?? 0;
  if (h <= overtimeThreshold) return null;
  const rule = overtimeRule(payType);
  if (rule === "salaried") return null;
  if (rule === "hourly") {
    return { label: `Overtime: ${round2(h - overtimeThreshold)}h over ${overtimeThreshold}h`, action: "Review overtime before payroll." };
  }
  return {
    label: `Over ${overtimeThreshold}h, pay type not set in Connecteam`,
    action: "Set this worker's pay rate type (hourly or salary) in Connecteam so overtime is computed correctly.",
  };
}
