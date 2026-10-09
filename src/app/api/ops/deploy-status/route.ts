// In-app DEPLOY STATUS endpoint. Read-only observability for any signed staff who can view AI (same bar as
// the Improvements page). Returns the live build identity plus, when GitHub is connected, whether the live
// build is current and how the last Deploy run went. No secrets reach the client.

import { NextResponse } from "next/server";
import { getDeployStatus } from "@/lib/ops/deployStatus";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canViewAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(await getDeployStatus());
}
