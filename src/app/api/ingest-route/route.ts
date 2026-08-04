// Start Route → kick off Goodshuffle ingestion. Returns immediately with a
// `scraping` route; the tablet polls /api/route until ready/failed. This is the
// app-side trigger for the async "AI browsing" job (see lib/ingest).

import { NextResponse } from "next/server";
import { startIngestion } from "@/lib/ingest/goodshuffleIngest";

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
  const route = startIngestion(body.truckId, body.date);
  return NextResponse.json({ route }, { status: 202 });
}
