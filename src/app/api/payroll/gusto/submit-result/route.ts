// POST /api/payroll/gusto/submit-result — the extension (extension/gusto-submit.js) POSTs the OUTCOME of an
// IRREVERSIBLE payroll SUBMIT here, from INSIDE the logged-in app.gusto.com tab after replaying
// SubmitDraftPayroll. Hit cross-origin, so it mirrors /api/payroll/gusto/import + /push-result EXACTLY:
// force-dynamic, CORS to app.gusto.com, GS_INGEST_TOKEN (fail-open), public in the proxy. We NEVER call
// Gusto here — we only persist what the browser reported (idempotently) + audit + post the #payroll card.
//
// IDEMPOTENCY: recorded via the period-keyed ledger, which never overwrites an authoritative success — a
// period can't be double-recorded as submitted. On a submit success we post the "Payroll submitted … wire
// $Y, then confirm" card to #payroll (deduped per period), which is the hand-off to the Confirm-wire step.

import { NextResponse } from "next/server";
import {
  recordGustoSubmitResult,
  periodKey,
  type GustoSubmitResult,
  type SubmitError,
} from "@/lib/payroll/gustoSubmitState";
import { postPayrollCard, PAYROLL_PERSONA } from "@/lib/payroll/slack";
import { formatUsd } from "@/lib/payroll/wireEvent";
import { appUrl, type BotCard } from "@/lib/notify/aiBots";
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
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean => v === true;

function parseErrors(v: unknown): SubmitError[] {
  if (!Array.isArray(v)) return [];
  const out: SubmitError[] = [];
  for (const e of v) {
    const o = (e ?? {}) as { argument?: unknown; message?: unknown };
    const message = str(o.message);
    if (message) out.push({ argument: str(o.argument), message });
  }
  return out;
}

interface IncomingBody {
  ok?: unknown;
  aborted?: unknown;
  submitted?: unknown;
  alreadySubmitted?: unknown;
  draftPayrollId?: unknown;
  payrollId?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
  checkDate?: unknown;
  uniqueIdentifier?: unknown;
  expectedTotal?: unknown;
  headcount?: unknown;
  wirePathTaken?: unknown;
  errors?: unknown;
  initiatedBy?: unknown;
}

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

  const aborted = str(body.aborted);
  const submitted = bool(body.submitted) || bool(body.alreadySubmitted);
  const errors = parseErrors(body.errors);
  // Honest OK: completed (not aborted), payroll ended up submitted, no errors.
  const ok = !aborted && submitted && errors.length === 0 && body.ok !== false;
  const periodStart = str(body.periodStart);
  const periodEnd = str(body.periodEnd);
  const key = periodKey(periodStart, periodEnd);

  const result: GustoSubmitResult = {
    key,
    at: new Date().toISOString(),
    ok,
    aborted,
    submitted,
    alreadySubmitted: bool(body.alreadySubmitted),
    draftPayrollId: str(body.draftPayrollId),
    payrollId: str(body.payrollId),
    periodStart,
    periodEnd,
    checkDate: str(body.checkDate),
    uniqueIdentifier: str(body.uniqueIdentifier),
    expectedTotal: num(body.expectedTotal),
    headcount: num(body.headcount),
    wirePathTaken: typeof body.wirePathTaken === "boolean" ? body.wirePathTaken : null,
    errors,
    initiatedBy: str(body.initiatedBy),
  };

  const { recorded, result: effective } = recordGustoSubmitResult(result);

  logImport("gusto_submit", ok, {
    rowsWritten: ok ? 1 : 0,
    detail: aborted
      ? `aborted: ${aborted}`
      : submitted
        ? `submitted${effective.alreadySubmitted ? " (already submitted)" : ""}${recorded ? "" : " (duplicate ignored)"}`
        : `not submitted${errors.length ? `: ${errors[0].message}` : ""}`,
  });

  // Audit the REAL payroll run (best-effort — never fail the record on an audit error).
  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({
      actor: result.initiatedBy ?? "Auto-Pull extension (Gusto submit)",
      action: "payroll.gusto.submit",
      entity: "gusto_payroll",
      entityId: result.payrollId ?? result.draftPayrollId ?? key,
      after: { ok, aborted, submitted, alreadySubmitted: result.alreadySubmitted, checkDate: result.checkDate, expectedTotal: result.expectedTotal, headcount: result.headcount, wirePathTaken: result.wirePathTaken, errors },
    });
  } catch {
    /* audit is best-effort */
  }

  // Post the #payroll hand-off card ONCE on a fresh, authoritative submit success (deduped per period).
  if (ok && recorded && !effective.alreadySubmitted) {
    try {
      await postPayrollCard(submittedCard(effective), `submit:${key}`);
    } catch {
      /* slack is best-effort */
    }
  }

  return NextResponse.json({ ok: true, recorded, submitted, duplicate: !recorded }, { headers: CORS });
}

/** The "payroll submitted, now wire + confirm" hand-off card. House style: no dashes, no emoji. */
function submittedCard(r: GustoSubmitResult): BotCard {
  const period = r.periodStart && r.periodEnd ? `${r.periodStart} to ${r.periodEnd}` : r.checkDate ?? "this period";
  const total = r.expectedTotal != null ? formatUsd(r.expectedTotal) : "an amount shown in Gusto";
  return {
    title: "Payroll submitted in Gusto",
    emoji: PAYROLL_PERSONA.icon,
    fields: [
      { label: "Pay period", value: period },
      { label: "Check date", value: r.checkDate ?? "unknown" },
      { label: "Estimated total", value: r.expectedTotal != null ? formatUsd(r.expectedTotal) : "unknown" },
      { label: "Workers", value: r.headcount != null ? String(r.headcount) : "unknown" },
    ],
    body: `Payroll submitted for ${period}. Total ${total}. Wire that amount to Gusto by wire transfer, then confirm the wire in Gusto. This step does not move money.`,
    link: { text: "Open Payroll", url: appUrl("/payroll?tab=review") },
    context: "Payroll Bot. Next step, wire by wire transfer, then confirm the wire in Gusto.",
  };
}
