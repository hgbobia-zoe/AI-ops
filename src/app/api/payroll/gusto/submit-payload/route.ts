// POST /api/payroll/gusto/submit-payload — builds the CONFIRM CONTEXT for the IRREVERSIBLE "Run payroll"
// trigger on /payroll. The Admin-only "Run payroll" control calls this (an app session) to get the real
// numbers to show in the hard confirm (period, grand total, headcount, target check-date), then hands the
// payload to the Auto-Pull extension ({type:"zoe-gusto-submit"}), which replays Gusto's SubmitDraftPayroll
// in a logged-in app.gusto.com tab. This endpoint NEVER calls Gusto itself — it only computes the context
// from the deterministic readiness model + the submit ledger.
//
// GATES (all mandatory): canManagePayroll (the whole blade) AND canRunPayroll (the dedicated
// administrator-level trigger gate for this irreversible action). Honors the GUSTO_SUBMIT_DISABLED kill
// switch (409). Returns `alreadySubmitted` from the ledger so the UI won't arm a second submit for a period.
// This is HUMAN-TRIGGERED ONLY — nothing here auto-submits.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManagePayroll, canRunPayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { namedPeriod } from "@/lib/payroll/period";
import { derivePayrollReadiness } from "@/lib/payroll/readinessModel";
import { getPayrollConfig } from "@/lib/payroll/config";
import { buildSubmitContext, runPayrollGate } from "@/lib/payroll/gustoSubmit";
import { gustoSubmitDisabled, readGustoSubmitResult, isAlreadySubmitted, periodKey } from "@/lib/payroll/gustoSubmitState";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const role = await viewerRole();
  // Blade gate + the dedicated irreversible-action gate. Both must pass.
  if (!canManagePayroll(role) || !canRunPayroll(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Kill switch — a hard stop on the whole submit feature.
  if (gustoSubmitDisabled()) {
    return NextResponse.json({ error: "Payroll submit is disabled (GUSTO_SUBMIT_DISABLED).", disabled: true }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as { which?: "current" | "previous" };
  const today = await safeToday();
  // Payroll runs for the LAST COMPLETED week (the previous named period) — the only week that maps to the
  // active Gusto draft. Default previous; current is accepted but only meaningful once that week completes.
  const which = body.which === "current" ? "current" : "previous";
  const period = namedPeriod(today, which);

  const cfg = getPayrollConfig();
  const model = await derivePayrollReadiness(period);
  const key = periodKey(period.start, period.end);
  const lastSubmit = readGustoSubmitResult(key);
  const alreadySubmitted = isAlreadySubmitted(lastSubmit);

  const context = buildSubmitContext({ model, payrollDay: cfg.payrollDay, alreadySubmitted, disabled: false });
  const gate = runPayrollGate({ approved: context.approved, alreadySubmitted, disabled: false });
  const actor = await currentActor();

  return NextResponse.json({
    which,
    period: context.period,
    checkDate: context.checkDate,
    expectedTotal: context.expectedTotal, // app-side ESTIMATE, not the Gusto debit
    headcount: context.headcount,
    approved: context.approved,
    alreadySubmitted,
    canRun: gate.canRun,
    reason: gate.reason,
    initiatedBy: actor.label,
    lastSubmit: lastSubmit
      ? { at: lastSubmit.at, ok: lastSubmit.ok, submitted: lastSubmit.submitted, aborted: lastSubmit.aborted }
      : null,
  });
}

async function safeToday(): Promise<string> {
  try {
    return (await commandCenter()).today;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
