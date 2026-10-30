// Gusto "we received your wire transfer" confirmation → payroll Slack channel. The RECEIVE-side bookend to
// the Mercury "wire sent" webhook (/api/payroll/wire-detected). A Gmail → Zapier zap (trigger: a new email
// from assurance@gusto.com whose subject contains "wire transfer") POSTs the email here. We parse the
// amount/date, correlate to the wire we already recorded (and the pay period), mark that wire
// confirmed-received, and post ONCE to the payroll channel in the shared payroll Slack voice. READ-only: it
// never moves money and never runs or confirms payroll in Gusto.
//
// Auth: reuses the wire webhook's token (header `x-wire-token` vs env WIRE_WEBHOOK_TOKEN). Fail-CLOSED once set
// (must match, else 401); fail-OPEN until set — the SAME posture as /api/payroll/wire-detected and the other
// inbound webhooks. EXACT path on the proxy PUBLIC allowlist so the Zap can POST with no session; the token is
// the gate. CORS is permissive (Zapier has no fixed origin) and is not a security control.
//
// Idempotency: a stable receipt key (Gmail message id, else amount+date) is recorded once posted, so Zapier
// retries / Gmail re-deliveries post exactly once. A body with neither an amount nor a message id is
// acknowledged and ignored so Zapier does not retry.

import { NextResponse } from "next/server";
import {
  payrollPeriodCandidates,
  matchWireAmount,
  findUnconfirmedWireByAmount,
  markWireReceiptConfirmed,
  wasReceiptPosted,
  markReceiptPosted,
  formatUsd,
  type WirePeriodMatch,
} from "@/lib/payroll/wireEvent";
import { normalizeGustoReceipt, receiptDedupKey, gustoReceiptCard } from "@/lib/payroll/gustoWireReceipt";
import { postPayrollCard } from "@/lib/payroll/slack";
import { logImport } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-wire-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  // Token gate: fail-closed once WIRE_WEBHOOK_TOKEN is set, fail-open until then (wire-detected posture).
  const token = process.env.WIRE_WEBHOOK_TOKEN;
  if (token && req.headers.get("x-wire-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const receipt = normalizeGustoReceipt(raw);
  // Need at least an amount OR a message id to say anything useful; otherwise acknowledge and ignore so the
  // Zap does not retry.
  if (receipt.amountAbs == null && !receipt.messageId) {
    return NextResponse.json({ ok: true, ignored: true, reason: "no amount or message id" }, { headers: CORS });
  }

  // Idempotency: this receipt key was already posted → do nothing (no second Slack post, no re-mark).
  const dedupKey = receiptDedupKey(receipt);
  if (wasReceiptPosted(dedupKey)) {
    return NextResponse.json({ ok: true, ignored: false, posted: false, duplicate: true }, { headers: CORS });
  }

  // Correlate: prefer the pay period from the matching wire we already recorded; else best-effort from the
  // review estimate. Never fabricated — a miss just omits the period line.
  const matchedWire = findUnconfirmedWireByAmount(receipt.amountAbs);
  let period: WirePeriodMatch | null = matchedWire?.matchedPeriod ?? null;
  if (!period) {
    try {
      period = matchWireAmount(receipt.amountAbs, await payrollPeriodCandidates());
    } catch {
      /* best-effort */
    }
  }

  const now = new Date().toISOString();
  const res = await postPayrollCard(gustoReceiptCard(receipt, period), dedupKey);
  const posted = res.ok && !res.skipped;

  // Record the receipt key + enrich the matched wire ONLY after the post succeeds, so a Slack failure lets
  // Zapier retry and post later rather than silently dropping the confirmation.
  if (res.ok) {
    markReceiptPosted(dedupKey, now);
    if (matchedWire) {
      markWireReceiptConfirmed(matchedWire.transactionId, { amountAbs: receipt.amountAbs, date: receipt.date, at: now });
    }
  }

  try {
    logImport("payroll_wire_receipt", res.ok, {
      rowsIn: 1,
      rowsWritten: posted ? 1 : 0,
      detail: `Gusto receipt ${formatUsd(receipt.amountAbs)}${period ? ` [${period.periodLabel}]` : " [period unconfirmed]"}${matchedWire ? ` matched ${matchedWire.transactionId}` : " unmatched"}${res.skipped ? " (dedup skip)" : ""}`,
    });
  } catch {
    /* the ledger is observability only; never fail the webhook on it */
  }

  return NextResponse.json(
    {
      ok: true,
      ignored: false,
      posted,
      matchedTransactionId: matchedWire?.transactionId ?? null,
      matchedPeriod: period,
    },
    { headers: CORS },
  );
}
