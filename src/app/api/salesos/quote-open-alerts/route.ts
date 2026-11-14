// Quote opened alerts, traced (owner/admin only). No "just opened their quote" alert was seen after
// 2026-10-21, and nothing recorded why. GET returns:
//   trace  the last 200 decisions the alert made (posted / post_failed / stale / no_slack), newest first
//   opens  every open captured in the last ?days= (default 14) with the facts the alert checks and the
//          reason it would or would not fire
// Read only: never posts to Slack.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getDb } from "@/lib/db";
import { quoteOpenTrace, quoteOpenWhyNot } from "@/lib/salesos/quoteOpenAlert";

export const dynamic = "force-dynamic";

interface OpenRow {
  booking_id: string;
  client_name: string | null;
  status_label: string | null;
  quote_sent_at: string | null;
  quote_sent_date: string | null;
  last_sent_date: string | null;
  quote_opened_at: string;
  quote_open_alerted_at: string | null;
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 14));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT booking_id, client_name, status_label, quote_sent_at, quote_sent_date, last_sent_date, quote_opened_at, quote_open_alerted_at
         FROM bookings WHERE quote_opened_at IS NOT NULL AND quote_opened_at >= ? ORDER BY quote_opened_at DESC`,
    )
    .all(since) as OpenRow[];
  const opens = rows.map((r) => {
    const why = quoteOpenWhyNot(r);
    return { ...r, wouldAlert: why === null, whyNot: why };
  });
  return NextResponse.json({ ok: true, days, trace: quoteOpenTrace(), opens });
}
