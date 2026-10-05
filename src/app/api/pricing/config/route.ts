// Delivery pricing config API — powers the Pricing section of /admin. The config (base fee, tiered
// mileage rates, the subtotal % + cap, and the route-engine knobs) was code/env-only; this makes it
// team-editable with no deploy, mirroring /api/finance/ops-cycle. GET returns the current config (no
// secrets). POST (owner/admin, enforced server-side AND at the proxy settings gate) validates + persists
// it via savePricingConfig and returns the merged, sanitized, stored config.

import { NextResponse } from "next/server";
import { pricingConfig, savePricingConfig, defaultPricingConfig, type PricingConfig } from "@/lib/pricing/config";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({ config: pricingConfig(), default: defaultPricingConfig() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: Partial<PricingConfig>;
  try {
    body = (await req.json()) as Partial<PricingConfig>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  // savePricingConfig merges + sanitizes (orders the tiers, forces an open-ended last band, clamps numbers),
  // so a bad value can never break the formula; we return the stored truth.
  const config = savePricingConfig(body);
  return NextResponse.json({ ok: true, config });
}
