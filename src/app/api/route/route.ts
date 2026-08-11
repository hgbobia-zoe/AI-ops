// Read endpoint for the tablet's current-route view.
//
// Production: proxies to the ingestion worker, which owns route state (durable
// across serverless instances). Dev/mock: reads the in-process store. Either way
// the client sees the same contract — `route: null` means no route started yet
// (→ the tablet shows the Start Route screen).

import { NextResponse } from "next/server";
import { getRoute } from "@/lib/ingest/routeStore";
import { workerBase, workerHeaders } from "@/lib/ingest/worker";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const truckId = url.searchParams.get("truckId");
  if (!truckId) {
    return NextResponse.json({ error: "missing_truckId" }, { status: 400 });
  }

  const base = workerBase();
  if (base) {
    try {
      const res = await fetch(
        `${base}/route?truckId=${encodeURIComponent(truckId)}`,
        { headers: workerHeaders(), cache: "no-store" },
      );
      const data = (await res.json()) as { route?: unknown };
      return NextResponse.json(
        { route: data.route ?? null },
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      return NextResponse.json({ route: null }, { headers: { "cache-control": "no-store" } });
    }
  }

  // Dev / mock — in-process store.
  return NextResponse.json(
    { route: getRoute(truckId) },
    { headers: { "cache-control": "no-store" } },
  );
}
