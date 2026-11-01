// POST /api/payroll/gusto/contractor-payload — the CONTRACTOR pay plan for a pay period (owner/admin). Reads
// the deterministic payroll review (Connecteam hours × the worker roster) and returns, per contractor (US +
// international), whether they are ready to stage in Gusto or need a decision (no Gusto match → Exclude,
// no rate, under Gusto's $25 international minimum). The /payroll "Contractor pay" panel shows this as the
// in-app review, and on the human's Confirm hands `entries` to the Auto-Pull extension. This endpoint NEVER
// calls Gusto and never pays: staging happens in the browser, payment is a human click in Gusto.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { namedPeriod } from "@/lib/payroll/period";
import { payrollReview } from "@/lib/payroll/review";
import { buildContractorPlan, CONTRACTOR_DOCS, DEFAULT_TRANSFER_PURPOSE, type ContractorPlanInput } from "@/lib/payroll/gustoContractorPay";
import { gustoContractorDisabled, readContractorRun } from "@/lib/payroll/gustoContractorState";
import type { ReviewWorker } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

const toInput = (w: ReviewWorker): ContractorPlanInput => ({
  key: w.key,
  name: w.name,
  workerType: w.workerType,
  hours: w.hours,
  payRate: w.payRate,
  gustoId: w.gustoId ?? null,
});

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { which?: "current" | "previous" };
  const which = body.which === "current" ? "current" : "previous"; // contractors are paid for the CLOSED week
  const period = namedPeriod(await safeToday(), which);

  const review = await payrollReview(period);
  const active = review.workers.map(toInput);
  const excluded = review.excluded.map(toInput);
  const plan = buildContractorPlan([...active, ...excluded], excluded.map((w) => w.key));

  return NextResponse.json({
    period,
    which,
    disabled: gustoContractorDisabled(),
    connecteamOk: review.connecteamOk,
    plan,
    // Exclusion context for the UI (why someone is excluded, and how).
    exclusions: review.excluded.map((w) => ({ key: w.key, mode: w.excludeMode ?? null, reason: w.excludeReason ?? null })),
    // What the extension needs to stage the draft (docs are the live-verified compact GraphQL).
    job: { docs: CONTRACTOR_DOCS, transferPurpose: DEFAULT_TRANSFER_PURPOSE, periodStart: period.start, periodEnd: period.end },
    lastRun: readContractorRun(),
  });
}

async function safeToday(): Promise<string> {
  try {
    return (await commandCenter()).today;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
