// On-demand route auto-assign. Normally the Connecteam<->route auto-assign runs on the runtime tick, but
// that tick is gated behind an unset RUNTIME_TOKEN, so in practice nothing auto-assigns today. This lets an
// owner/admin trigger the SAME engine (reconcileRouteAutoSyncForDate) for the viewed day on demand from the
// Dispatch header. It performs REAL app assignments (same path as the dispatcher's one-click) — hence the
// owner/admin gate. Connecteam-unreachable is a no-op (reachable:false), surfaced to the caller.
//
// Body: { date?: string } — defaults to today in the ops timezone.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { reconcileRouteAutoSyncForDate } from "@/lib/scheduling/routeAutoSync";
import { todayInOpsTz } from "@/lib/dates";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let date = todayInOpsTz();
  try {
    const body = (await req.json()) as { date?: string } | null;
    if (body && typeof body.date === "string" && body.date) date = body.date;
  } catch {
    /* no/invalid body — default to today */
  }

  try {
    const result = await reconcileRouteAutoSyncForDate(date, "dispatch-on-demand");
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "auto_assign_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
