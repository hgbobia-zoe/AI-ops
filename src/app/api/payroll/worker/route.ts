// POST /api/payroll/worker — edit one worker's HR/payroll record: classification, pay rate, currency,
// country, and the Gusto mapping (resolving the "no Gusto mapping" / missing-config blockers). Owner/admin.
// A human-set Gusto mapping is authoritative (CONFIRMED); never silently changed. Audited.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManagePayroll } from "@/lib/auth/roles";
import { ensureWorkerFromConnecteam, getWorkerById, updateWorker, type WorkerPatch } from "@/lib/payroll/store";
import type { GustoEntityType, PayType, WorkerType } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

interface Body {
  recordId?: string;
  connecteamUserId?: number;
  name?: string;
  workerType?: WorkerType;
  payType?: PayType | null;
  payRate?: number | null;
  currency?: string | null;
  country?: string | null;
  gustoId?: string | null;
  gustoEntityType?: GustoEntityType | null;
  active?: boolean;
}

export async function POST(req: Request): Promise<Response> {
  if (!canManagePayroll(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Body;

  // Resolve the record: an existing hr_workers row, or create one from the Connecteam id on first edit.
  let recordId = b.recordId ?? null;
  if (!recordId && typeof b.connecteamUserId === "number") {
    recordId = ensureWorkerFromConnecteam({ connecteamUserId: b.connecteamUserId, name: b.name ?? `#${b.connecteamUserId}` }).id;
  }
  if (!recordId || !getWorkerById(recordId)) return NextResponse.json({ error: "worker not found" }, { status: 404 });

  const patch: WorkerPatch = {
    workerType: b.workerType,
    payType: b.payType,
    payRate: b.payRate,
    currency: b.currency,
    country: b.country,
    gustoId: b.gustoId,
    gustoEntityType: b.gustoEntityType,
    active: b.active,
  };
  const updated = updateWorker(recordId, patch);

  try {
    const { insertAudit } = await import("@/lib/db/repo");
    const actor = await currentActor();
    insertAudit({ actor: actor.label, action: "payroll.worker.edit", entity: "hr_worker", entityId: recordId, after: patch });
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ ok: true, worker: updated });
}
