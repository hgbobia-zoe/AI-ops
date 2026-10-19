// POST /api/payroll/exception — resolve or ignore a payroll exception (an explicit human action; nothing
// is silently discarded, spec §5). Owner/admin only. Audited.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { resolveException } from "@/lib/payroll/store";
import { reconcileReadinessException } from "@/lib/payroll/readiness";
import type { ExceptionStatus } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

const ALLOWED: ExceptionStatus[] = ["OPEN", "IN_REVIEW", "RESOLVED", "IGNORED"];

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { id?: string; status?: ExceptionStatus; resolution?: string; action?: "resolve" | "reconcile" };
  if (!b.id) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const actor = await currentActor();

  // RECONCILE (spec §6): verify against the AUTHORITATIVE Connecteam record — a click alone is not proof the
  // underlying timesheet changed. Only clears the exception when the live record now passes.
  if (b.action === "reconcile") {
    const r = await reconcileReadinessException(b.id, actor.label);
    try {
      const { insertAudit } = await import("@/lib/db/repo");
      insertAudit({ actor: actor.label, action: "payroll.exception.reconcile", entity: "hr_exception", entityId: b.id, after: { cleared: r.cleared, detail: r.detail } });
    } catch {
      /* best-effort */
    }
    return NextResponse.json(r, { status: r.ok ? 200 : 409 });
  }

  // Manual resolve / ignore (an explicit human action; nothing is silently discarded).
  if (!b.status || !ALLOWED.includes(b.status)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  resolveException(b.id, { status: b.status, resolution: b.resolution ?? null, resolvedBy: actor.label });
  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({ actor: actor.label, action: "payroll.exception.resolve", entity: "hr_exception", entityId: b.id, after: { status: b.status, resolution: b.resolution ?? null } });
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ ok: true });
}
