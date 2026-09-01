// Resolve an exception from the dispatch board — the office has handled whatever a
// driver flagged, so it clears off the open list. Read-mostly app has no auth yet;
// this is an office action on /dispatch.
//
// Body: { exceptionId: string }

import { NextResponse } from "next/server";
import { resolveException } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let exceptionId: string | undefined;
  try {
    exceptionId = ((await req.json()) as { exceptionId?: string })?.exceptionId;
  } catch {
    /* fall through to 400 */
  }
  if (!exceptionId) {
    return NextResponse.json({ error: "exceptionId required" }, { status: 400 });
  }
  const ok = resolveException(exceptionId);
  if (!ok) {
    return NextResponse.json({ error: "exception not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, exceptionId });
}
