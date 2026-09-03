// Route import — writes a route + stops straight to the DB (status "ready").
// This is the endpoint the in-app Goodshuffle extractor (kiosk webview) POSTs the
// parsed route to, and it's how a route can be seeded manually / for testing.
//
// Body: { truckId, date?, stops: [{ custName, custPhone, address, dayOfName?,
//         dayOfPhone?, plannedWindow?, eta? }, ...] }

import { NextResponse } from "next/server";
import { getRouteForDate, writeRoute, saveEventRevenue, type EventFinancialRecord } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import { alertRouteRisks } from "@/lib/notify/routeRisk";
import { scheduleScanSoon } from "@/lib/risk/scan";
import { recordPullSuccess } from "@/lib/pull/state";
import { reconcileStops } from "@/lib/ingest/reconcile";
import type { Stop } from "@/lib/types";

export const dynamic = "force-dynamic";

// CORS: allow the "Pull Zoe Routes" bookmarklet — which runs INSIDE a logged-in
// Goodshuffle tab — to POST the extracted route here. Restricted to the Goodshuffle
// origin so only code running there (using the operator's own session) can post.
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
  // Cross-origin write from the office bookmarklet — gated by the ingest token (enforced once
  // GS_INGEST_TOKEN is set; the bookmarklet carries it). CORS is not a security control.
  const publishToken = process.env.GS_INGEST_TOKEN;
  if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  let body: {
    truckId?: string;
    date?: string;
    gsRouteId?: string;
    stops?: Array<Partial<Stop>>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS });
  }

  const truckId = body.truckId;
  const stopsIn = body.stops;
  if (!truckId || !Array.isArray(stopsIn) || stopsIn.length === 0) {
    return NextResponse.json({ error: "truckId and non-empty stops[] required" }, { status: 400, headers: CORS });
  }

  const date = body.date || todayInOpsTz();
  const routeId = `R-${date}-${truckId}`;

  // Reconcile the fresh pull against the SAME date's existing route (not the truck's latest, which
  // may be another day) — preserving every acted-on stop, matching by Goodshuffle txId (never array
  // position), and overlaying the active EnRoute stop with any corrected address. Pure + tested in
  // src/lib/ingest/reconcile.ts.
  const existing = getRouteForDate(truckId, date);
  const { stops, keptCount } = reconcileStops(existing?.stops ?? [], stopsIn, routeId);

  writeRoute({ routeId, date, truckId, status: "ready", gsRouteId: body.gsRouteId, stops });

  // Forward any Goodshuffle contract totals captured with this pull into event_financials
  // (Financial Intelligence). Cents → dollars; keyed by txId; one record per distinct event.
  // Only the incoming stops carry totals (frozen/kept stops keep their prior revenue).
  const revenueByTx = new Map<string, EventFinancialRecord>();
  for (const s of stopsIn) {
    const tx = s.txId;
    const cents = s.grandTotalCents;
    if (!tx || typeof cents !== "number" || !Number.isFinite(cents)) continue;
    const revenue = Math.round(cents) / 100;
    const collected = typeof s.paidCents === "number" && Number.isFinite(s.paidCents) ? Math.round(s.paidCents) / 100 : null;
    revenueByTx.set(tx, {
      eventId: tx,
      date,
      label: s.custName || undefined,
      routeId,
      revenue,
      revenueStatus: collected != null && collected >= revenue ? "COLLECTED" : "SIGNED",
      collected,
    });
  }
  if (revenueByTx.size > 0) saveEventRevenue([...revenueByTx.values()]);

  // Mark data fresh — powers the freshness banner + resets the staleness alarm.
  recordPullSuccess(truckId, stops.length);

  // Proactive Slack heads-up for business/office stops scheduled outside open hours
  // (so a truck doesn't roll up while the place is closed). Fire-and-forget; throttled.
  void alertRouteRisks({ routeId, date, truckId, status: "ready", stops }, truckId);

  // Route data just changed → refresh the Event Risk queue. Debounced so the 3 AM all-trucks
  // pull (a burst of imports) settles into ONE scan; runScan itself is throttled to 5 min.
  scheduleScanSoon();

  return NextResponse.json(
    {
      ok: true,
      routeId,
      stops: stops.length,
      kept: keptCount,
      firstStopId: stops[0]?.stopId,
    },
    { headers: CORS },
  );
}
