// Opportunity Radar — scheduled source pull. Point any scheduler (Fly scheduled machine, cron-job.org,
// GitHub Actions, etc.) at this endpoint to auto-run the API sources so opportunities self-populate.
// Runs SERVER-SIDE (no browser needed) — today that's SAM.gov (federal solicitations); browser-agent
// procurement sources are fed separately via /api/radar/ingest.
//
// Auth: RADAR_INGEST_TOKEN (the one radar token) via ?token= or the x-radar-token header. Fails OPEN
// only when the token is unset (dev); once set, a caller must present it. Public in the proxy (token,
// not a session). Idempotent — re-running upserts in place, so a scheduler can hit it freely.

import { NextResponse } from "next/server";
import { runOpportunitySource } from "@/lib/opportunity/ingest";
import { samGovSource, samGovConfigured } from "@/lib/opportunity/sources/samgov";
import { syncEventOpportunities } from "@/lib/opportunity/eventBridge";
import { runSource } from "@/lib/radar/ingest";
import { configuredIcsSources, icsFeedsConfigured } from "@/lib/radar/sources/ics";

export const dynamic = "force-dynamic";

async function run(req: Request): Promise<NextResponse> {
  const token = process.env.RADAR_INGEST_TOKEN;
  if (token) {
    const provided = req.headers.get("x-radar-token") || new URL(req.url).searchParams.get("token") || "";
    if (provided !== token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ran: Record<string, unknown>[] = [];
  // Configured API sources. SAM.gov is the only one today; add future API adapters to this list.
  if (samGovConfigured()) {
    try {
      const res = await runOpportunitySource(samGovSource());
      ran.push({ source: "samgov-federal", ok: true, ...res });
    } catch (e) {
      ran.push({ source: "samgov-federal", ok: false, error: String(e).slice(0, 200) });
    }
  } else {
    ran.push({ source: "samgov-federal", ok: false, dormant: true, message: "SAM_API_KEY not set" });
  }

  // ICS / iCal EVENT feeds (server-side, no key). Each runs the event pipeline; bridge once after.
  if (icsFeedsConfigured()) {
    const now = new Date();
    for (const s of configuredIcsSources()) {
      try {
        const res = await runSource(s, now);
        ran.push({ source: s.id, ok: res.errors.length === 0, ...res });
      } catch (e) {
        ran.push({ source: s.id, ok: false, error: String(e).slice(0, 200) });
      }
    }
    try { syncEventOpportunities(now); } catch { /* non-fatal */ }
  } else {
    ran.push({ source: "ics-events", ok: false, dormant: true, message: "RADAR_ICS_FEEDS not set" });
  }

  return NextResponse.json({ ok: true, ranAt: new Date().toISOString(), sources: ran });
}

export async function GET(req: Request): Promise<NextResponse> {
  return run(req);
}

export async function POST(req: Request): Promise<NextResponse> {
  return run(req);
}
