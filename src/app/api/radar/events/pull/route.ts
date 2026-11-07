// Event Radar — server-side EVENT pull (ICS / iCal feeds). Point any scheduler (Fly scheduled machine,
// cron-job.org, GitHub Actions) at this, or hit it from the Sources page, to pull the configured public
// event calendars. Runs SERVER-SIDE (no browser, no key) through the existing event pipeline
// (runSource → radar_events), then bridges the results into the unified Opportunity layer so new events
// surface on the board and can be handed to Sales OS.
//
// Auth: RADAR_INGEST_TOKEN in the x-radar-token header (or Bearer). FAIL CLOSED: 503 when unset, 401
// when wrong; no ?token= query string. Idempotent: re-running upserts events in place by their stable
// ICS UID. The runtime clock (job "opportunity-radar") already runs these feeds on a schedule.
//
// Dormant until RADAR_ICS_FEEDS is configured — the response says so explicitly, which is the exact,
// documented blocker (one or more public .ics feed URLs; no paid key).

import { NextResponse } from "next/server";
import { requireMachineToken } from "@/lib/auth/machineToken";
import { runSource } from "@/lib/radar/ingest";
import { configuredIcsSources, icsFeedsConfigured } from "@/lib/radar/sources/ics";
import { syncEventOpportunities } from "@/lib/opportunity/eventBridge";

export const dynamic = "force-dynamic";

async function run(req: Request): Promise<NextResponse> {
  const denied = requireMachineToken(req, { env: "RADAR_INGEST_TOKEN", header: "x-radar-token", bearer: true });
  if (denied) return denied;

  if (!icsFeedsConfigured()) {
    return NextResponse.json({
      ok: false,
      dormant: true,
      message: "No event calendars configured — set RADAR_ICS_FEEDS to one or more public .ics feed URLs to enable the live event feed.",
    });
  }

  const now = new Date();
  const sources = configuredIcsSources();
  const feeds: Record<string, unknown>[] = [];
  for (const s of sources) {
    try {
      const res = await runSource(s, now);
      feeds.push({ source: s.id, name: s.name, ok: res.errors.length === 0, ...res });
    } catch (e) {
      feeds.push({ source: s.id, name: s.name, ok: false, error: String(e).slice(0, 200) });
    }
  }
  // Bridge the freshly-pulled events into the unified Opportunity layer (idempotent).
  let bridged = 0;
  try { bridged = syncEventOpportunities(now); } catch { /* non-fatal */ }

  return NextResponse.json({ ok: true, ranAt: now.toISOString(), bridged, feeds });
}

export async function GET(req: Request): Promise<NextResponse> {
  return run(req);
}

export async function POST(req: Request): Promise<NextResponse> {
  return run(req);
}
