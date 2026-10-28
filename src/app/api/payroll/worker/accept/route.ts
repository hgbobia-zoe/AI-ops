// POST /api/payroll/worker/accept — accept a REQUIRES_REVIEW worker into THIS period's run (promote to
// READY / pushable), or un-accept them. The inverse of the exclude route. Owner/admin. Audited.
// Per-period only (hr_payroll_review_accepts, keyed by the review worker key ct:<id> | hw:<id>). The
// promotion itself is enforced in classifyReview, which never promotes a BLOCKED (unmapped) worker.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { addReviewAccept, removeReviewAccept } from "@/lib/payroll/store";

export const dynamic = "force-dynamic";

interface Body {
  action?: "accept" | "unaccept";
  workerKey?: string; // ct:<id> | hw:<id>
  name?: string;
  note?: string;
  periodStart?: string;
  periodEnd?: string;
}

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Body;
  const action = b.action === "unaccept" ? "unaccept" : "accept";
  const key = (b.workerKey ?? "").trim();
  if (!key) return NextResponse.json({ error: "workerKey required" }, { status: 400 });
  if (!b.periodStart || !b.periodEnd) return NextResponse.json({ error: "periodStart and periodEnd required" }, { status: 400 });

  const actor = await currentActor();
  if (action === "accept") {
    addReviewAccept({ periodStart: b.periodStart, periodEnd: b.periodEnd, workerKey: key, acceptedBy: actor.label, note: (b.note ?? "").trim() || null });
  } else {
    removeReviewAccept(b.periodStart, b.periodEnd, key);
  }

  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({ actor: actor.label, action: `payroll.worker.${action}`, entity: "hr_worker", entityId: key, after: { name: b.name ?? null, period: `${b.periodStart}..${b.periodEnd}` } });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true });
}
