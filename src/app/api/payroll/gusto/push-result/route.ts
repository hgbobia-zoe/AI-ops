// POST /api/payroll/gusto/push-result — the extension (extension/gusto-push.js) POSTs the OUTCOME of a
// DRAFT-only Gusto hours push here (per-worker pushed/skipped/failed). It runs INSIDE the logged-in
// app.gusto.com tab after replaying AutoSaveWorkedHours, so this is hit cross-origin — mirror the
// /api/payroll/gusto/import gate EXACTLY: force-dynamic, CORS to app.gusto.com, GS_INGEST_TOKEN (fail-open),
// public in the proxy. We NEVER call Gusto here — we only persist what the browser reported, for honest
// status + audit. This endpoint records; it does not push.

import { NextResponse } from "next/server";
import { recordGustoPushResult, type GustoPushResult, type GustoPushWorkerResult } from "@/lib/payroll/gustoPushState";
import { logImport } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://app.gusto.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

interface IncomingWorker {
  gustoMemberId?: unknown;
  name?: unknown;
  outcome?: unknown;
  regularHours?: unknown;
  overtimeHours?: unknown;
  reason?: unknown;
}
interface IncomingBody {
  ok?: unknown;
  aborted?: unknown;
  draftPayrollId?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
  initiatedBy?: unknown;
  sessionMode?: unknown;
  workers?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function POST(req: Request): Promise<NextResponse> {
  const token = process.env.GS_INGEST_TOKEN;
  if (token && req.headers.get("x-publish-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }

  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const rawWorkers = Array.isArray(body.workers) ? (body.workers as IncomingWorker[]) : [];
  const workers: GustoPushWorkerResult[] = [];
  for (const w of rawWorkers) {
    const id = str(w.gustoMemberId);
    const outcome = str(w.outcome);
    if (!id || (outcome !== "pushed" && outcome !== "skipped" && outcome !== "failed")) continue;
    workers.push({
      gustoMemberId: id,
      name: str(w.name),
      outcome,
      regularHours: num(w.regularHours),
      overtimeHours: num(w.overtimeHours),
      reason: str(w.reason),
    });
  }

  const pushed = workers.filter((w) => w.outcome === "pushed").length;
  const skipped = workers.filter((w) => w.outcome === "skipped").length;
  const failed = workers.filter((w) => w.outcome === "failed").length;
  const aborted = str(body.aborted);
  // Honest OK: the run must have completed (not aborted) with zero failures. Zero pushed + zero failed is a
  // valid "nothing to do" success (e.g. everything idempotently skipped).
  const ok = !aborted && failed === 0 && body.ok !== false;
  const sessionModeRaw = str(body.sessionMode);
  const sessionMode = sessionModeRaw === "captured" || sessionModeRaw === "generated" ? sessionModeRaw : null;

  const result: GustoPushResult = {
    at: new Date().toISOString(),
    ok,
    aborted,
    draftPayrollId: str(body.draftPayrollId),
    periodStart: str(body.periodStart),
    periodEnd: str(body.periodEnd),
    pushed,
    skipped,
    failed,
    workers,
    initiatedBy: str(body.initiatedBy),
    sessionMode,
  };

  recordGustoPushResult(result);

  logImport("gusto_push", ok, {
    rowsWritten: pushed,
    rowsSkipped: skipped,
    detail: aborted
      ? `aborted: ${aborted}`
      : `${pushed} pushed, ${skipped} skipped, ${failed} failed${sessionMode ? ` · session ${sessionMode}` : ""}`,
  });

  // Audit the write to real payroll (best-effort — never fail the record on an audit error).
  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({
      actor: result.initiatedBy ?? "Auto-Pull extension (Gusto push)",
      action: "payroll.gusto.push_hours",
      entity: "gusto_draft_payroll",
      entityId: result.draftPayrollId ?? `${result.periodStart ?? "?"}..${result.periodEnd ?? "?"}`,
      after: { ok, aborted, pushed, skipped, failed, sessionMode, workers },
    });
  } catch {
    /* audit is best-effort */
  }

  return NextResponse.json({ ok: true, recorded: { pushed, skipped, failed, ok } }, { headers: CORS });
}
