// POST /api/payroll/gusto/confirm-wire-result — the extension (extension/gusto-submit.js) POSTs the OUTCOME
// of a wire CONFIRM here, from INSIDE the logged-in app.gusto.com tab after running WireInInstructions +
// ConfirmWireIn. Hit cross-origin, so it mirrors /push-result + /submit-result EXACTLY: force-dynamic, CORS
// to app.gusto.com, GS_INGEST_TOKEN (fail-open), public in the proxy. We NEVER call Gusto here — we persist
// what the browser reported (idempotently, never double-confirm) + audit + post the "wire confirmed" card.

import { NextResponse } from "next/server";
import {
  recordGustoConfirmWireResult,
  periodKey,
  type GustoConfirmWireResult,
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
  confirmed?: unknown;
  alreadyConfirmed?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
  checkDate?: unknown;
  wireId?: unknown;
  amount?: unknown;
  gustoAmount?: unknown;
  wireDate?: unknown;
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
  const confirmed = bool(body.confirmed) || bool(body.alreadyConfirmed);
  const errors = parseErrors(body.errors);
  const ok = !aborted && confirmed && errors.length === 0 && body.ok !== false;
  const periodStart = str(body.periodStart);
  const periodEnd = str(body.periodEnd);
  const key = periodKey(periodStart, periodEnd);

  const result: GustoConfirmWireResult = {
    key,
    at: new Date().toISOString(),
    ok,
    aborted,
    confirmed,
    alreadyConfirmed: bool(body.alreadyConfirmed),
    periodStart,
    periodEnd,
    checkDate: str(body.checkDate),
    wireId: str(body.wireId),
    amount: num(body.amount),
    gustoAmount: num(body.gustoAmount),
    wireDate: str(body.wireDate),
    errors,
    initiatedBy: str(body.initiatedBy),
  };

  const { recorded, result: effective } = recordGustoConfirmWireResult(result);

  logImport("gusto_confirm_wire", ok, {
    rowsWritten: ok ? 1 : 0,
    detail: aborted
      ? `aborted: ${aborted}`
      : confirmed
        ? `confirmed${effective.alreadyConfirmed ? " (already confirmed)" : ""}${recorded ? "" : " (duplicate ignored)"}`
        : `not confirmed${errors.length ? `: ${errors[0].message}` : ""}`,
  });

  try {
    const { insertAudit } = await import("@/lib/db/repo");
    insertAudit({
      actor: result.initiatedBy ?? "Auto-Pull extension (Gusto wire confirm)",
      action: "payroll.gusto.confirm_wire",
      entity: "gusto_payroll",
      entityId: result.wireId ?? key,
      after: { ok, aborted, confirmed, alreadyConfirmed: result.alreadyConfirmed, amount: result.amount, gustoAmount: result.gustoAmount, wireDate: result.wireDate, errors },
    });
  } catch {
    /* audit is best-effort */
  }

  if (ok && recorded && !effective.alreadyConfirmed) {
    try {
      await postPayrollCard(confirmedCard(effective), `wire-confirm:${key}`);
    } catch {
      /* slack is best-effort */
    }
  }

  return NextResponse.json({ ok: true, recorded, confirmed, duplicate: !recorded }, { headers: CORS });
}

/** The "wire confirmed in Gusto" card. House style: no dashes, no emoji. */
function confirmedCard(r: GustoConfirmWireResult): BotCard {
  const period = r.periodStart && r.periodEnd ? `${r.periodStart} to ${r.periodEnd}` : r.checkDate ?? "this period";
  return {
    title: "Wire confirmed in Gusto",
    emoji: PAYROLL_PERSONA.icon,
    fields: [
      { label: "Pay period", value: period },
      { label: "Amount", value: r.amount != null ? formatUsd(r.amount) : "unknown" },
      { label: "Wire date", value: r.wireDate ?? "unknown" },
    ],
    body: `Wire confirmed in Gusto for ${period}. Amount ${r.amount != null ? formatUsd(r.amount) : "shown in Gusto"}. Payroll funding is recorded.`,
    link: { text: "Open Payroll", url: appUrl("/payroll?tab=review") },
    context: "Payroll Bot. The wire is confirmed in Gusto.",
  };
}
