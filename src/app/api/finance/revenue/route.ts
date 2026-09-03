// Ingest Goodshuffle contract revenue for events, keyed by Goodshuffle transactionID (= our
// stops.tx_id). The server can't call Goodshuffle (Cloudflare blocks server-side calls), so a
// logged-in client (the pull extractor, or a manual backfill) fetches
// `/app/vendorPayment/loadPaymentHistoryAndContractTotals?transactionID=<tx>` and POSTs the
// results here. Amounts arrive in CENTS (Goodshuffle's unit) and are stored as dollars.
//
// Security: gated by KIOSK_PUBLISH_TOKEN (the trusted-writer secret), via the x-publish-token
// header — same as the kiosk publish endpoint. Disabled (503) until the secret is set.
//
// Body: { items: [{ transactionId, grandTotalCents, paidCents?, date?, label? }] }

import { NextResponse } from "next/server";
import { saveEventRevenue, getEventStub, type EventFinancialRecord } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

interface InItem {
  transactionId?: string | number;
  grandTotalCents?: number;
  paidCents?: number;
  date?: string;
  label?: string;
}

const dollars = (cents: number | null | undefined): number | null =>
  cents == null || !Number.isFinite(cents) ? null : Math.round(cents) / 100;

export async function POST(req: Request): Promise<NextResponse> {
  const token = process.env.KIOSK_PUBLISH_TOKEN;
  if (!token) return NextResponse.json({ error: "revenue ingest disabled (set KIOSK_PUBLISH_TOKEN)" }, { status: 503 });
  if (req.headers.get("x-publish-token") !== token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { items?: InItem[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return NextResponse.json({ error: "items[] required" }, { status: 400 });

  const records: EventFinancialRecord[] = [];
  const skipped: { transactionId: string; reason: string }[] = [];

  for (const it of items) {
    const tx = it.transactionId != null ? String(it.transactionId) : "";
    if (!tx) {
      skipped.push({ transactionId: "", reason: "missing transactionId" });
      continue;
    }
    const revenue = dollars(it.grandTotalCents);
    if (revenue == null) {
      skipped.push({ transactionId: tx, reason: "missing/invalid grandTotalCents" });
      continue;
    }
    // Prefer our own stored context; fall back to what the caller sent.
    const stub = getEventStub(tx);
    const date = stub?.date ?? it.date;
    if (!date) {
      skipped.push({ transactionId: tx, reason: "no event date (unknown tx and none provided)" });
      continue;
    }
    const collected = dollars(it.paidCents);
    records.push({
      eventId: tx,
      date,
      label: stub?.label || it.label,
      routeId: stub?.routeId,
      revenue,
      // SIGNED when we know the contract total; upgrade to COLLECTED once fully paid.
      revenueStatus: collected != null && collected >= revenue ? "COLLECTED" : "SIGNED",
      collected,
    });
  }

  if (records.length > 0) saveEventRevenue(records);

  return NextResponse.json({ ok: true, saved: records.length, skipped });
}
