// Route import — writes a route + stops straight to the DB (status "ready").
// This is the endpoint the in-app Goodshuffle extractor (kiosk webview) POSTs the
// parsed route to, and it's how a route can be seeded manually / for testing.
//
// Body: { truckId, date?, stops: [{ custName, custPhone, address, dayOfName?,
//         dayOfPhone?, plannedWindow?, eta? }, ...] }

import { NextResponse } from "next/server";
import { getRoute, writeRoute } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import type { Stop } from "@/lib/types";

export const dynamic = "force-dynamic";

// CORS: allow the "Pull Zoe Routes" bookmarklet — which runs INSIDE a logged-in
// Goodshuffle tab — to POST the extracted route here. Restricted to the Goodshuffle
// origin so only code running there (using the operator's own session) can post.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://pro.goodshuffle.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  Vary: "Origin",
};

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: {
    truckId?: string;
    date?: string;
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

  const mkStop = (s: Partial<Stop>, i: number): Stop => ({
    stopId: `${routeId}-S${i + 1}`,
    routeId,
    customerId: `${routeId}-C${i + 1}`,
    sequence: i + 1,
    state: "Waiting",
    custName: s.custName ?? "",
    custFirstName: s.custFirstName ?? undefined,
    kind: s.kind === "pickup" ? "pickup" : s.kind === "delivery" ? "delivery" : undefined,
    custPhone: s.custPhone ?? "",
    address: s.address ?? "",
    dayOfName: s.dayOfName,
    dayOfPhone: s.dayOfPhone,
    plannedWindow: s.plannedWindow,
    eta: s.eta,
  });

  // Overlay the mutable customer/address fields of an incoming stop onto an existing
  // one, preserving its identity, state, and timestamps. Used to push a correction
  // onto the stop the driver is already EnRoute to.
  const overlay = (existingStop: Stop, incoming?: Partial<Stop>): Stop =>
    incoming
      ? {
          ...existingStop,
          custName: incoming.custName ?? existingStop.custName,
          custFirstName: incoming.custFirstName ?? existingStop.custFirstName,
          kind: incoming.kind ?? existingStop.kind,
          custPhone: incoming.custPhone ?? existingStop.custPhone,
          address: incoming.address ?? existingStop.address,
          dayOfName: incoming.dayOfName ?? existingStop.dayOfName,
          dayOfPhone: incoming.dayOfPhone ?? existingStop.dayOfPhone,
          plannedWindow: incoming.plannedWindow ?? existingStop.plannedWindow,
          eta: incoming.eta ?? existingStop.eta,
        }
      : existingStop;

  // Reconcile: if the driver has already started this route, keep the stops they've
  // acted on (the leading non-Waiting prefix) and only replace the UPCOMING (Waiting)
  // tail with the newly-imported stops — so dispatch can push an overnight / mid-day
  // change without erasing progress. First run (nothing started) = full replace.
  //
  // Completed / Arrived / in-progress stops are frozen (their data is historical).
  // The one exception is a stop the driver is currently EnRoute to (on the way, not
  // yet arrived): that's exactly the emergency case — a corrected address must reach
  // the driver — so we overlay its contact/address fields from the matching incoming
  // stop while keeping it the active EnRoute stop.
  const existing = getRoute(truckId);
  const actioned: Stop[] = [];
  for (const s of existing?.stops ?? []) {
    if (s.state === "Waiting") break;
    actioned.push(s);
  }

  let stops: Stop[];
  let reconciled = false;
  if (existing && actioned.length > 0) {
    const upcoming = stopsIn
      .slice(actioned.length)
      .map((s, i) => mkStop(s, actioned.length + i));
    const kept = actioned.map((s, i) => {
      const base = s.state === "EnRoute" ? overlay(s, stopsIn[i]) : s;
      return { ...base, sequence: i + 1 };
    });
    stops = [...kept, ...upcoming];
    reconciled = true;
  } else {
    stops = stopsIn.map(mkStop);
  }

  writeRoute({ routeId, date, truckId, status: "ready", stops });
  return NextResponse.json(
    {
      ok: true,
      routeId,
      stops: stops.length,
      kept: reconciled ? actioned.length : 0,
      firstStopId: stops[0]?.stopId,
    },
    { headers: CORS },
  );
}
