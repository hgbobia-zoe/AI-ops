// POST /api/inventory/catalog — pull a partner's whole storefront catalog and return its DISTINCT groups
// (slug + display name + item count), for the add-partner flow's mapping UI. Owner/admin only
// (canManageSettings). READ-ONLY. Never throws — a failed storefront fetch returns ok:false + an error.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { discoverPartnerGroups } from "@/lib/inventory/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ ok: false, error: "forbidden", total: 0, groups: [] }, { status: 403 });

  let body: { token?: unknown };
  try {
    body = (await req.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json", total: 0, groups: [] }, { status: 400 });
  }

  const token = typeof body?.token === "string" ? body.token : "";
  const result = await discoverPartnerGroups(token);
  return NextResponse.json(result);
}
