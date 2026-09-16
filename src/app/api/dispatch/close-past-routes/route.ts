// Bulk-close every route still open past its scheduled delivery date (the same set the route-health
// banner/alert flags). Closing preserves each stop's real state and pushes any unfinished stops into the
// "needs rescheduling" list; it clears the overdue backlog off the board. Owner/Admin only (a bulk
// mutation), or the internal REANALYZE_TOKEN for a cron. Posts ONE Slack summary. Idempotent-ish: routes
// already closed are skipped.

import { NextResponse } from "next/server";
import { findRouteHealthIssues } from "@/lib/dispatch/routeHealth";
import { closeOneRoute } from "@/lib/dispatch/closeRoute";
import { slackNotify } from "@/lib/notify/slack";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function tokenOk(req: Request): boolean {
  const secret = process.env.REANALYZE_TOKEN?.trim();
  if (!secret) return false;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return bearer === secret || req.headers.get("x-reanalyze-token")?.trim() === secret;
}

export async function POST(req: Request): Promise<NextResponse> {
  // Either an Owner/Admin in the app, or the internal jobs token.
  if (!tokenOk(req) && !canManageSettings(await viewerRole())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }

  const past = findRouteHealthIssues(); // open routes with date < today
  let closed = 0;
  let already = 0;
  const rescheduling: { truckLabel: string; date: string; stops: number }[] = [];
  const byId = new Map(past.map((i) => [i.routeId, i]));

  for (const issue of past) {
    const res = closeOneRoute(issue.routeId);
    if (!res.ok) continue;
    if (res.already) { already++; continue; }
    closed++;
    const n = res.incomplete?.length ?? 0;
    if (n > 0) rescheduling.push({ truckLabel: byId.get(issue.routeId)?.truckLabel ?? res.truckId ?? "Route", date: issue.date, stops: n });
  }

  // One summary to the ops channel (not one message per route).
  if (closed > 0) {
    const lines = [`:white_check_mark: *Closed ${closed} past route${closed === 1 ? "" : "s"}* that were still open past their delivery date.`];
    if (rescheduling.length > 0) {
      const totalStops = rescheduling.reduce((s, r) => s + r.stops, 0);
      lines.push(`⚠️ ${rescheduling.length} of them had ${totalStops} unfinished stop${totalStops === 1 ? "" : "s"} that now need rescheduling:`);
      for (const r of rescheduling.slice(0, 12)) lines.push(`• ${r.truckLabel} — ${r.date}: ${r.stops} stop${r.stops === 1 ? "" : "s"}`);
      if (rescheduling.length > 12) lines.push(`…and ${rescheduling.length - 12} more.`);
    }
    void slackNotify(lines.join("\n"));
  }

  return NextResponse.json({ ok: true, closed, already, needRescheduling: rescheduling.length });
}
