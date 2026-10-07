// POST /api/payroll/exception — resolve or ignore a payroll exception (an explicit human action; nothing
// is silently discarded, spec §5). Owner/admin only. Audited.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { resolveException } from "@/lib/payroll/store";
import type { ExceptionStatus } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

const ALLOWED: ExceptionStatus[] = ["OPEN", "IN_REVIEW", "RESOLVED", "IGNORED"];

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { id?: string; status?: ExceptionStatus; resolution?: string };
  if (!b.id || !b.status || !ALLOWED.includes(b.status)) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const actor = await currentActor();
  resolveException(b.id, { status: b.status, resolution: b.resolution ?? null, resolvedBy: actor.label });
  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({ actor: actor.label, action: "payroll.exception.resolve", entity: "hr_exception", entityId: b.id, after: { status: b.status, resolution: b.resolution ?? null } });
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ ok: true });
}
