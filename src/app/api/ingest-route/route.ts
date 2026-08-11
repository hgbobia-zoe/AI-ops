// Start Route → kick off Goodshuffle ingestion.
//
// Production: proxies to the ingestion worker (which runs the browser + Computer
// Use scrape and stores the result). Dev/mock: runs the local mock ingestion.
// Returns immediately with a `scraping` route; the tablet polls /api/route.

import { NextResponse } from "next/server";
import { startIngestion } from "@/lib/ingest/goodshuffleIngest";
import { workerBase, workerHeaders } from "@/lib/ingest/worker";

export async function POST(req: Request) {
  let body: { truckId?: string; date?: string };
  try {
    body = (await req.json()) as { truckId?: string; date?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.truckId) {
    return NextResponse.json({ error: "missing_truckId" }, { status: 400 });
  }

  const base = workerBase();
  if (base) {
    try {
      const res = await fetch(`${base}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", ...workerHeaders() },
        body: JSON.stringify({ truckId: body.truckId, date: body.date }),
      });
      const data = await res.json().catch(() => ({}));
      return NextResponse.json(data, { status: res.status });
    } catch {
      return NextResponse.json({ error: "worker_unreachable" }, { status: 502 });
    }
  }

  // Dev / mock — run locally against the in-process store.
  const route = startIngestion(body.truckId, body.date);
  return NextResponse.json({ route }, { status: 202 });
}
