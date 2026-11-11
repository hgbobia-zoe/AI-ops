// Goodshuffle payment histories for the offline payment confirmation. The fast Auto-Pull reads
// GET /app/vendorPayment/loadPaymentHistoryAndContractTotals for the projects /api/gs/projects named in
// `paymentIds` (their amount paid went up) and posts a trimmed copy here:
//   { payments: [{ bookingId, ok, grandTotalCents, paidCents, events: [{ id, type, offlinePayment, paymentType,
//     label, amount (CENTS), dateMillis, status, processedBy }] }] }
// Each NEW offline charge raises one approve-first confirmation card (src/lib/payments/offlineConfirmService.ts).
// Same posture as the other GS ingest routes: CORS-locked to pro.goodshuffle.com, GS_INGEST_TOKEN when set.

import { NextResponse } from "next/server";
import { ingestPaymentHistories, type InPaymentHistory } from "@/lib/payments/offlineConfirmService";
import { logImport } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://pro.goodshuffle.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-publish-token",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: { payments?: InPaymentHistory[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }
  const payments = Array.isArray(body.payments) ? body.payments.slice(0, 100) : [];
  if (payments.length === 0) return NextResponse.json({ error: "payments[] required" }, { status: 400, headers: CORS });
  try {
    const r = ingestPaymentHistories(payments);
    logImport("gs_payments", true, { rowsIn: payments.length, rowsWritten: r.newPayments, detail: `${r.offlineSeen} offline, ${r.cardsRaised} cards` });
    return NextResponse.json({ ok: true, ...r }, { headers: CORS });
  } catch (e) {
    console.error("[gs/payments] ingest failed", e);
    logImport("gs_payments", false, { rowsIn: payments.length, rowsWritten: 0, detail: e instanceof Error ? e.message : "ingest failed" });
    return NextResponse.json({ ok: false, error: "ingest_failed" }, { status: 500, headers: CORS });
  }
}
