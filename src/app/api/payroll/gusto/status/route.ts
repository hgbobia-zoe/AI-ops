// GET /api/payroll/gusto/status?which=previous — the latest Gusto push + submit results the extension has
// reported, for the Run payroll dialog to poll while a step runs in the hidden Gusto tab. Read-only; it only
// reads the ledgers the result endpoints write. Same gate as the rest of the payroll blade.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { namedPeriod } from "@/lib/payroll/period";
import { readGustoPushResult } from "@/lib/payroll/gustoPushState";
import { readGustoSubmitResult, periodKey } from "@/lib/payroll/gustoSubmitState";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManagePayroll(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const which = new URL(req.url).searchParams.get("which") === "current" ? "current" : "previous";
  let today: string;
  try {
    today = (await commandCenter()).today;
  } catch {
    today = new Date().toISOString().slice(0, 10);
  }
  const period = namedPeriod(today, which);
  const push = readGustoPushResult();
  const submit = readGustoSubmitResult(periodKey(period.start, period.end));

  return NextResponse.json({
    period,
    push: push
      ? { at: push.at, ok: push.ok, aborted: push.aborted, periodStart: push.periodStart, periodEnd: push.periodEnd, pushed: push.pushed, skipped: push.skipped, failed: push.failed, workers: push.workers }
      : null,
    submit: submit
      ? { at: submit.at, ok: submit.ok, aborted: submit.aborted, submitted: submit.submitted, alreadySubmitted: submit.alreadySubmitted, checkDate: submit.checkDate, expectedTotal: submit.expectedTotal, headcount: submit.headcount, errors: submit.errors }
      : null,
  });
}
