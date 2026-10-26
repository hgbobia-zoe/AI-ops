// POST /api/payroll/gusto/push-payload — builds the DRAFT-only Gusto hours-push payload for a pay period.
// The /payroll "Push hours to Gusto" button calls this (an app session, owner/admin only) to get the list
// of entries, then hands it to the Auto-Pull extension ({type:"zoe-gusto-push"}), which replays Gusto's
// AutoSaveWorkedHours mutation in a logged-in app.gusto.com tab. This endpoint NEVER calls Gusto itself — it
// only computes WHICH workers + WHAT hours from the deterministic review (review.ts). Only MAPPED +
// NOT-BLOCKED workers with hours are included; everyone else is returned in `skipped` with a reason.
// Honest: it builds the plan, it does not push — the real outcome comes back via /api/payroll/gusto/push-result.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { namedPeriod } from "@/lib/payroll/period";
import { payrollReview } from "@/lib/payroll/review";
import { unifiedWorkers } from "@/lib/payroll/workers";
import { getPayrollConfig } from "@/lib/payroll/config";
import { buildPushEntries } from "@/lib/payroll/gustoPush";
import { gustoPushDisabled } from "@/lib/payroll/gustoPushState";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Kill switch — a hard stop on the whole push, independent of the per-worker gates.
  if (gustoPushDisabled()) {
    return NextResponse.json({ error: "Gusto push is disabled (GUSTO_PUSH_DISABLED).", disabled: true }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as { which?: "current" | "previous" };
  const today = await safeToday();
  const period = namedPeriod(today, body.which === "previous" ? "previous" : "current");

  const overtimeThreshold = getPayrollConfig().overtimeThreshold;
  const [review, { workers: unified }] = await Promise.all([payrollReview(period), unifiedWorkers(period)]);
  const built = buildPushEntries(review.workers, unified, overtimeThreshold);

  return NextResponse.json({
    period,
    which: body.which === "previous" ? "previous" : "current",
    overtimeThreshold,
    entries: built.entries,
    mappedCount: built.mappedCount,
    skipped: built.skipped,
    totals: { regular: built.totalRegular, overtime: built.totalOvertime },
  });
}

async function safeToday(): Promise<string> {
  try {
    return (await commandCenter()).today;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
