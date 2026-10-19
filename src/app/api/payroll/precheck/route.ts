// POST /api/payroll/precheck — run the payroll READINESS pre-check on demand (the same assessment the
// scheduled Monday/Tuesday job runs). Assesses the period, persists any exceptions into the queue, and
// (optionally) posts the idempotent readiness summary to the dedicated payroll Slack channel. READ-ONLY on
// payroll — it never mutates hours and NEVER submits Gusto payroll. Owner/admin only; the proxy also gates
// /api/payroll.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { resolvePeriod, namedPeriod } from "@/lib/payroll/period";
import { assessReadiness, persistReadinessExceptions } from "@/lib/payroll/readiness";
import { postPayrollReadiness } from "@/lib/payroll/slack";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { which?: "current" | "previous"; start?: string; end?: string; notify?: boolean };
  const today = (await safeToday()) ?? new Date().toISOString().slice(0, 10);
  const period =
    body.which === "current" || body.which === "previous"
      ? namedPeriod(today, body.which)
      : resolvePeriod(today, body.start, body.end);

  const readiness = await assessReadiness(period);
  const { opened } = persistReadinessExceptions(readiness);

  // Notify is opt-in for the manual run (the scheduled job always posts). Idempotent either way.
  let slack: { posted?: boolean; channel: string | null } | null = null;
  if (body.notify) {
    const r = await postPayrollReadiness(readiness, "manual");
    slack = { posted: r.summary.ok && !r.summary.skipped, channel: r.channel };
  }

  return NextResponse.json({ period, readiness, openedExceptions: opened, slack });
}

async function safeToday(): Promise<string | null> {
  try {
    return (await commandCenter()).today;
  } catch {
    return null;
  }
}
