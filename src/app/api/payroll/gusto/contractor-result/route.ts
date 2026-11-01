// POST /api/payroll/gusto/contractor-result — the Auto-Pull extension (extension/gusto-contractor.js) reports
// the OUTCOME of staging a contractor run in Gusto: which contractors got hours on the draft, Gusto's own review
// result (the computed debits, ACH speed, or Gusto's error messages), and the review URL where a human submits.
// Hit cross-origin from app.gusto.com, so it mirrors /api/payroll/gusto/push-result EXACTLY: CORS to
// app.gusto.com, GS_INGEST_TOKEN (fail-open), public in the proxy. Records only; never calls Gusto, never pays.

import { NextResponse } from "next/server";
import { contractorReviewUrl, recordContractorRun, type ContractorRunMember, type ContractorRunResult } from "@/lib/payroll/gustoContractorState";
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

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export async function POST(req: Request): Promise<NextResponse> {
  const token = process.env.GS_INGEST_TOKEN;
  if (token && req.headers.get("x-publish-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const members: ContractorRunMember[] = [];
  for (const m of Array.isArray(b.members) ? (b.members as Record<string, unknown>[]) : []) {
    const outcome = str(m.outcome);
    if (outcome !== "staged" && outcome !== "unmatched" && outcome !== "failed") continue;
    const by = str(m.matchedBy);
    members.push({
      key: str(m.key),
      name: str(m.name),
      memberUuid: str(m.memberUuid),
      hours: num(m.hours),
      matchedBy: by === "id" || by === "name" ? by : null,
      outcome,
      debit: num(m.debit),
      reason: str(m.reason),
    });
  }

  const aborted = str(b.aborted);
  const reviewOk = b.reviewOk === true;
  const failed = members.filter((m) => m.outcome === "failed").length;
  const stage: ContractorRunResult["stage"] = aborted ? "aborted" : reviewOk ? "staged" : "review_failed";
  const payGroupId = str(b.payGroupId);
  const reviewErrors = Array.isArray(b.reviewErrors) ? (b.reviewErrors as unknown[]).map((e) => String(e)).filter(Boolean).slice(0, 20) : [];

  const result: ContractorRunResult = {
    at: new Date().toISOString(),
    ok: stage === "staged" && failed === 0,
    stage,
    aborted,
    payGroupId,
    reviewUrl: contractorReviewUrl(payGroupId),
    periodStart: str(b.periodStart),
    periodEnd: str(b.periodEnd),
    totalDebit: num(b.totalDebit),
    achSpeed: str(b.achSpeed),
    wireInFunded: typeof b.wireInFunded === "boolean" ? b.wireInFunded : null,
    reviewErrors,
    members,
    initiatedBy: str(b.initiatedBy),
  };
  recordContractorRun(result);

  const staged = members.filter((m) => m.outcome === "staged").length;
  logImport("gusto_contractor", result.ok, {
    rowsWritten: staged,
    rowsSkipped: members.length - staged,
    detail: aborted ? `aborted: ${aborted}` : `${staged} staged · review ${reviewOk ? "ok" : "failed"}${result.totalDebit != null ? ` · $${result.totalDebit}` : ""}`,
  });
  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({
      actor: result.initiatedBy ?? "Auto-Pull extension (Gusto contractor)",
      action: "payroll.gusto.contractor_stage",
      entity: "gusto_contractor_pay_group",
      entityId: payGroupId ?? `${result.periodStart ?? "?"}..${result.periodEnd ?? "?"}`,
      after: { stage, totalDebit: result.totalDebit, reviewErrors, members },
    });
  } catch {
    /* audit is best-effort */
  }
  return NextResponse.json({ ok: true, recorded: { stage, staged, failed } }, { headers: CORS });
}
