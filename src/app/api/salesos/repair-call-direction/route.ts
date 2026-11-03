// One time repair of outbound calls stored as inbound on lead timelines (see callDirectionRepair.ts).
// Owner/admin only. POST ?apply=1 writes; without it, it only reports. ?limit= (default 50, max 200)
// rows per request, newest first, older than ?before= (pass back nextBefore to continue).

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { repairCallDirections } from "@/lib/salesos/callDirectionRepair";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const apply = ["1", "true", "yes"].includes((sp.get("apply") ?? "").toLowerCase());
  const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 50));
  const before = sp.get("before")?.trim() || null;
  return NextResponse.json(await repairCallDirections({ apply, limit, before }));
}
