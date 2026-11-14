// "Check Deposit" bank account webhook. A Zapier zap (bank New Transaction trigger, filtered to the Check
// Deposit account) POSTs each deposit here; we store it and match it to a Goodshuffle project (project
// number in the memo, else a unique 50% deposit / amount due / full total match). The offline payment
// confirmation card then shows the matched deposit as proof the money landed. Since 2026-11-14 a cleared
// CHECK (Mercury kind checkDeposit) matched with confidence also sends the customer the check received email
// and text on its own (offlineConfirmService.confirmFromDeposit; kill switch OFFLINE_PAYMENT_CONFIRM). It
// never moves money; ACH, wires and payouts never message anyone.
//
// Body (Mercury field names, or plain ones): { transactionId|id, amount, postedAt|date|createdAt, note,
// externalMemo|memo|description, counterpartyName, bankDescription, accountName|account, status }.
//
// Auth: header x-bank-token vs BANK_WEBHOOK_TOKEN (falls back to x-wire-token vs WIRE_WEBHOOK_TOKEN, so the
// existing Mercury zap connection can carry it). Fail-open until a token is set, like the other inbound
// webhooks; on the proxy PUBLIC allowlist (exact path). Idempotent on the bank transaction id.

import { NextResponse } from "next/server";
import { recordBankDeposit, bankTokenOk } from "@/lib/payments/offlineConfirmService";
import { logImport } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-bank-token, x-wire-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!bankTokenOk(req.headers)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  try {
    const r = recordBankDeposit(raw);
    if (!r.ok) return NextResponse.json(r, { status: 400, headers: CORS });
    if (!r.ignored && !r.duplicate) logImport("bank_deposits", true, { rowsIn: 1, rowsWritten: 1, detail: r.match?.note });
    return NextResponse.json(r, { headers: CORS });
  } catch (e) {
    console.error("[payments/bank-deposit] failed", e);
    return NextResponse.json({ ok: false, error: "failed" }, { status: 500, headers: CORS });
  }
}
