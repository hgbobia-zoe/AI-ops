// Live health snapshot for the Connections dashboard + the auto-clearing PullHealthBanner. Same data
// the server renders, exposed so the client can poll and update (or hide the banner) without a full
// navigation. Owner/admin only (these are the roles that see + fix integrations).

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { pullBannerState, getRecentImports } from "@/lib/pull/state";
import { computeConnections, summarize } from "@/lib/health/connections";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const connections = computeConnections();
  return NextResponse.json({
    banner: pullBannerState(),
    connections,
    summary: summarize(connections),
    imports: getRecentImports(200),
    at: new Date().toISOString(),
  });
}
