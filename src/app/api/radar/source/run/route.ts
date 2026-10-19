// Run a configured API source on demand (a "Pull now" for the sources page). Server-side, no browser:
//  - SAM.gov (federal procurement) once SAM_API_KEY is set, and
//  - any configured ICS / iCal EVENT feed (RADAR_ICS_FEEDS) — runs the event pipeline, then bridges the
//    results into the unified Opportunity layer.
// Reports clearly when a source is dormant (no key / no feed configured). Gated to settings managers.

import { NextResponse } from "next/server";
import { runOpportunitySource } from "@/lib/opportunity/ingest";
import { samGovSource, samGovConfigured } from "@/lib/opportunity/sources/samgov";
import { syncEventOpportunities } from "@/lib/opportunity/eventBridge";
import { runSource } from "@/lib/radar/ingest";
import { icsEventSource, icsFeedsFromEnv } from "@/lib/radar/sources/ics";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { sourceId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const sourceId = (body.sourceId ?? "").trim();

  if (sourceId === "samgov-federal") {
    if (!samGovConfigured()) return NextResponse.json({ ok: false, dormant: true, message: "SAM.gov is dormant — set SAM_API_KEY to enable the live federal feed." });
    const result = await runOpportunitySource(samGovSource());
    return NextResponse.json({ ok: true, ...result });
  }

  // ICS / iCal event feeds. The dormant placeholder row id is "ics-events"; configured feeds carry their
  // own ids. Running one pulls events, then bridges them into the unified Opportunity layer.
  const feeds = icsFeedsFromEnv();
  if (sourceId === "ics-events" || sourceId.startsWith("ics:")) {
    const feed = feeds.find((f) => f.id === sourceId);
    if (!feed) return NextResponse.json({ ok: false, dormant: true, message: "No event calendars configured — set RADAR_ICS_FEEDS to one or more public .ics feed URLs to enable the live event feed." });
    const now = new Date();
    const result = await runSource(icsEventSource(feed), now);
    let bridged = 0;
    try { bridged = syncEventOpportunities(now); } catch { /* non-fatal */ }
    return NextResponse.json({ ok: result.errors.length === 0, bridged, ...result });
  }

  return NextResponse.json({ error: "only the SAM.gov API source and configured ICS event feeds can be run on demand; browser sources are fed by the local agent" }, { status: 400 });
}
