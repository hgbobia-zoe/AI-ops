// POST /api/payroll/worker/exclude — exclude a worker from payroll, or re-include them. Two modes:
//   mode "permanent" → sets hr_workers.excluded (they drop out of EVERY run until re-included)
//   mode "period"    → a per-period skip (hr_payroll_exclusions) for ONE pay period only
// action "exclude" requires a reason; "include" reverses it. Owner/admin. Audited (who, worker, mode, reason).

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import {
  ensureWorkerFromConnecteam, getWorkerById, updateWorker,
  addPeriodExclusion, removePeriodExclusion,
} from "@/lib/payroll/store";

export const dynamic = "force-dynamic";

interface Body {
  action?: "exclude" | "include";
  mode?: "permanent" | "period";
  recordId?: string;
  connecteamUserId?: number;
  workerKey?: string; // ct:<id> | hw:<id> — required for a per-period skip
  name?: string;
  reason?: string;
  periodStart?: string;
  periodEnd?: string;
}

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Body;
  const action = b.action === "include" ? "include" : "exclude";
  const mode = b.mode === "period" ? "period" : "permanent";
  const reason = (b.reason ?? "").trim();
  if (action === "exclude" && !reason) return NextResponse.json({ error: "a reason is required" }, { status: 400 });

  const actor = await currentActor();

  if (mode === "permanent") {
    // Resolve the record (create one from the Connecteam id on first touch, like the worker edit route).
    let recordId = b.recordId ?? null;
    if (!recordId && typeof b.connecteamUserId === "number") {
      recordId = ensureWorkerFromConnecteam({ connecteamUserId: b.connecteamUserId, name: b.name ?? `#${b.connecteamUserId}` }).id;
    }
    if (!recordId || !getWorkerById(recordId)) return NextResponse.json({ error: "worker not found" }, { status: 404 });
    const updated = action === "exclude"
      ? updateWorker(recordId, { excluded: true, excludeReason: reason })
      : updateWorker(recordId, { excluded: false, excludeReason: null });
    await audit(actor.label, action, "permanent", recordId, b.name ?? null, reason);
    return NextResponse.json({ ok: true, worker: updated });
  }

  // Per-period skip.
  const key = (b.workerKey ?? "").trim();
  if (!key) return NextResponse.json({ error: "workerKey required for a per-period exclusion" }, { status: 400 });
  if (!b.periodStart || !b.periodEnd) return NextResponse.json({ error: "periodStart and periodEnd required" }, { status: 400 });
  if (action === "exclude") {
    addPeriodExclusion({ periodStart: b.periodStart, periodEnd: b.periodEnd, workerKey: key, reason, excludedBy: actor.label });
  } else {
    removePeriodExclusion(b.periodStart, b.periodEnd, key);
  }
  await audit(actor.label, action, "period", key, b.name ?? null, reason, `${b.periodStart}..${b.periodEnd}`);
  return NextResponse.json({ ok: true });
}

async function audit(actor: string, action: string, mode: string, entityId: string, name: string | null, reason: string, period?: string): Promise<void> {
  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({ actor, action: `payroll.worker.${action}`, entity: "hr_worker", entityId, after: { mode, name, reason, period } });
  } catch { /* best-effort */ }
}
