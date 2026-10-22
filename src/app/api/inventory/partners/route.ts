// GET/POST /api/inventory/partners — read + persist the Inventory Automation partner list and the Zoe
// destination-category registry. Owner/admin only (canManageSettings), matching the blade's nav flag and
// the rest of /api/inventory — so the blade can add a partner WITHOUT the /admin PIN (it is role-gated).
// Both persist to the same team-editable settings row (src/lib/settings.ts); /admin edits the same data via
// /api/settings. Tokens stored here are PUBLIC storefront tokens, not secrets.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { getSettings, saveSettings } from "@/lib/settings";
import { coerceInventoryPartners, coerceZoeCategories } from "@/lib/inventory/partners";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const s = getSettings();
  return NextResponse.json({ partners: s.inventoryPartners, zoeCategories: s.zoeCategories });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { partners?: unknown; zoeCategories?: unknown };
  try {
    body = (await req.json()) as { partners?: unknown; zoeCategories?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const current = getSettings();
  const next = {
    ...current,
    inventoryPartners: Array.isArray(body.partners) ? coerceInventoryPartners(body.partners, current.inventoryPartners) : current.inventoryPartners,
    zoeCategories: Array.isArray(body.zoeCategories) ? coerceZoeCategories(body.zoeCategories, current.zoeCategories) : current.zoeCategories,
  };
  saveSettings(next);
  return NextResponse.json({ ok: true, partners: next.inventoryPartners, zoeCategories: next.zoeCategories });
}
