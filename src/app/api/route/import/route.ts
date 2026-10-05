// Route import — writes a route + stops straight to the DB (status "ready").
// This is the endpoint the in-app Goodshuffle extractor (kiosk webview) POSTs the
// parsed route to, and it's how a route can be seeded manually / for testing.
//
// Body: { truckId, date?, stops: [{ custName, custPhone, address, dayOfName?,
//         dayOfPhone?, plannedWindow?, eta? }, ...] }

import { NextResponse } from "next/server";
import { getRouteById, writeRoute } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import { alertRouteRisks } from "@/lib/notify/routeRisk";
import { scheduleScanSoon } from "@/lib/risk/scan";
import { recordPull, logImport } from "@/lib/pull/state";
import { reconcileStops, forceReconcileStops } from "@/lib/ingest/reconcile";
import { consumeForceResync } from "@/lib/ingest/forceResync";
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
  // Resilience: a single poisoned route row must NEVER fail the whole pull. The extension loops over
  // every (truck, route) and counts a non-2xx OR a throw as failed, then reports "routes failed to save"
  // and skips the prune. Worse, an UNHANDLED throw returns a 500 WITHOUT these CORS headers, so the
  // cross-origin caller sees only "Failed to fetch" and can't tell what went wrong. So: every exit path
  // (including the catch-all) carries CORS, and the per-route steps that touch prior state are each
  // guarded so a corrupt existing row self-heals (it gets overwritten by this fresh write) instead of
  // throwing. Discovered 2026-10-05: one route 500'd here and masked an otherwise-clean pull.
  const json = (data: unknown, status = 200): NextResponse => NextResponse.json(data, { status, headers: CORS });
  try {
    // Cross-origin write from the office extension — gated by the ingest token (enforced once
    // GS_INGEST_TOKEN is set; the extension carries it). CORS is not a security control.
    const publishToken = process.env.GS_INGEST_TOKEN;
    if (publishToken && req.headers.get("x-publish-token") !== publishToken) {
      return json({ error: "unauthorized" }, 401);
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
      return json({ error: "invalid_json" }, 400);
    }

    const truckId = body.truckId;
    const stopsIn = body.stops;
    if (!truckId || !Array.isArray(stopsIn) || stopsIn.length === 0) {
      return json({ error: "truckId and non-empty stops[] required" }, 400);
    }

    const date = body.date || todayInOpsTz();
    // Identity is PER GOODSHUFFLE ROUTE: a truck can run more than one route a day (a day route and an
    // evening route), and each must be its own row. The Goodshuffle route id makes them distinct; without
    // one (a manual/test import) we fall back to the one-per-truck-per-day id.
    const routeId = body.gsRouteId ? `R-${date}-${truckId}-${body.gsRouteId}` : `R-${date}-${truckId}`;

    // Reconcile the fresh pull against THIS route's own prior stops (by routeId, not the truck/day) —
    // preserving every acted-on stop, matching by Goodshuffle txId. Each step that reads prior state is
    // guarded: if the existing row is unreadable/corrupt, we treat it as a FRESH import (overwriting it)
    // rather than failing — so a bad row heals on the next pull instead of poisoning it forever.
    let existing: Awaited<ReturnType<typeof getRouteById>> = null;
    try {
      existing = getRouteById(routeId);
    } catch (e) {
      console.error("[route/import] getRouteById failed; treating as fresh", routeId, e);
      existing = null;
    }
    let force = false;
    try {
      force = consumeForceResync(routeId);
    } catch {
      force = false;
    }
    let stops: Stop[];
    let keptCount = 0;
    try {
      const r = force
        ? forceReconcileStops(existing?.stops ?? [], stopsIn, routeId)
        : reconcileStops(existing?.stops ?? [], stopsIn, routeId);
      stops = r.stops;
      keptCount = r.keptCount;
    } catch (e) {
      // A corrupt prior-stop set must not fail the save: fall back to a clean import of just the fresh
      // stops (reconcile against an empty prior still assigns stopIds + tracking tokens).
      console.error("[route/import] reconcile failed; using fresh stops", routeId, e);
      const r = reconcileStops([], stopsIn, routeId);
      stops = r.stops;
      keptCount = r.keptCount;
    }

    // Safety: a late re-pull must NOT resurrect a route the office/driver already closed. Keep a closed
    // route closed (reconcileStops still preserves its real stop states); only an open route stays "ready".
    const status = existing?.status === "done" ? "done" : "ready";
    writeRoute({ routeId, date, truckId, status, gsRouteId: body.gsRouteId, stops });

    // NOTE: revenue is NOT written here. The single source of truth is the `bookings` feed
    // (searchProjects), keyed by the same id as the stop's txId — see getBookingRevenueByIds.

    // Mark this truck's routes fresh (per-source) + ledger the import.
    recordPull(`route:${truckId}`, stops.length);
    logImport(`route:${truckId}`, true, { rowsIn: stopsIn.length, rowsWritten: stops.length });

    // Proactive Slack heads-up for business/office stops scheduled outside open hours. Fire-and-forget;
    // guarded so a risk-check throw on one stop can't fail an otherwise-good save.
    try {
      void alertRouteRisks({ routeId, date, truckId, status, stops }, truckId);
    } catch (e) {
      console.error("[route/import] alertRouteRisks threw", routeId, e);
    }

    // Route data just changed → refresh the Event Risk queue (debounced + throttled).
    try {
      scheduleScanSoon();
    } catch (e) {
      console.error("[route/import] scheduleScanSoon threw", e);
    }

    return json({ ok: true, routeId, stops: stops.length, kept: keptCount, firstStopId: stops[0]?.stopId });
  } catch (e) {
    // Last resort: still answer WITH CORS (so the caller sees a real error, never a bare "Failed to
    // fetch") and include a short detail for debugging.
    console.error("[route/import] unhandled error", e);
    return json({ error: "import_failed", detail: String(e).slice(0, 300) }, 500);
  }
}
