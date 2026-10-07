// POST /api/payroll/sync — run the payroll sync for a pay period (the manual "Sync Now"). Uses the SAME
// engine the Monday scheduler will call (runPayrollSync), so there is one implementation. Owner/admin only
// (defense-in-depth: the proxy also gates /api/payroll). Idempotent — re-running a period never duplicates.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { commandCenter } from "@/lib/command/service";
import { resolvePeriod, namedPeriod } from "@/lib/payroll/period";
import { runPayrollSync } from "@/lib/payroll/sync";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { which?: "current" | "previous"; start?: string; end?: string };
  const today = (await safeToday()) ?? new Date().toISOString().slice(0, 10);
  const period =
    body.which === "current" || body.which === "previous"
      ? namedPeriod(today, body.which)
      : resolvePeriod(today, body.start, body.end);

  const actor = await currentActor();
  const summary = await runPayrollSync({ periodStart: period.start, periodEnd: period.end, trigger: "manual", actor: actor.label });
  return NextResponse.json({ period, summary });
}

async function safeToday(): Promise<string | null> {
  try {
    return (await commandCenter()).today;
  } catch {
    return null;
  }
}
