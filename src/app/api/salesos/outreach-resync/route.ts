// Bulk Outreach — re-sync on demand. The cockpit's accuracy (last touch, the timeline strip, and the
// context-aware draft) depends on the comms log being fresh. This endpoint refreshes the two-way text
// threads for the open-lead cohort straight from the OpenPhone (Quo) API — the one sync the SERVER can run
// on demand (unlike the Goodshuffle bookings pull, which only the office Auto-Pull extension can trigger).
// After it returns the client calls router.refresh() to rebuild the cohort from the freshly-synced data.
// Owner/admin only — same gate as the cockpit page and the queue route.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { syncActiveLeadTextThreads } from "@/lib/comms/openphoneSync";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageSettings(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    // Pull the latest inbound + outbound texts for the open-lead cohort from the Quo API. A missing API key
    // is an honest no-op ({leads:0, inserted:0}); a single lead's failure never aborts the rest.
    const { leads, inserted } = await syncActiveLeadTextThreads();
    return NextResponse.json({ ok: true, leads, inserted });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "resync_failed" }, { status: 500 });
  }
}
