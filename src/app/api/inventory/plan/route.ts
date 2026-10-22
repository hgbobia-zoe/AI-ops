// POST /api/inventory/plan — resolve a bulk inventory-copy job into a concrete plan.
//
// Owner/admin only (canManageSettings), matching the blade's `manage` nav flag and the proxy gate for
// /api/inventory. Body = the job config (partnerKey OR raw {token, mappings}, selected groups, addTags,
// policy). It pulls the partner's source items + Zoe's current catalog server-side (the storefront data
// API is public + datacenter-reachable, unlike pro.goodshuffle.com) and returns the plan. READ-ONLY — it
// never writes to Goodshuffle; writes run from a logged-in GSPRO tab via the generated importer.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { planInventoryImport, type PlanJobRequest } from "@/lib/inventory/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: PlanJobRequest;
  try {
    body = (await req.json()) as PlanJobRequest;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const result = await planInventoryImport(body ?? {});
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
