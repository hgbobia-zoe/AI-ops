// POST /api/payroll/settings — save HR/Payroll policy (schedule, approval policy, overtime threshold).
// Owner/admin only (the proxy also gates /api/payroll). The scheduler + engine read this config.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { savePayrollConfig, type PayrollConfig } from "@/lib/payroll/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Partial<PayrollConfig>;
  const saved = savePayrollConfig(body);
  try {
    const { insertAudit } = await import("@/lib/db/repo");
    const actor = await currentActor();
    insertAudit({ actor: actor.label, action: "payroll.settings", entity: "hr_payroll_config", entityId: "app", after: saved });
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ ok: true, config: saved });
}
