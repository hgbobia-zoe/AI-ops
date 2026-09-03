// Reopen a route the office had closed, so its stops can be acted on again (e.g. remove a
// stop after Goodshuffle moved it to another day). Sets the route back to active/ready.
// Office action on /dispatch (no auth yet — internal URL).
//
// Body: { routeId: string }

import { NextResponse } from "next/server";
import { reopenRoute } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let routeId: string | undefined;
  try {
    routeId = ((await req.json()) as { routeId?: string })?.routeId;
  } catch {
    /* fall through */
  }
  if (!routeId) {
    return NextResponse.json({ error: "routeId required" }, { status: 400 });
  }
  const result = reopenRoute(routeId);
  if (!result.ok) {
    return NextResponse.json({ error: "route not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
