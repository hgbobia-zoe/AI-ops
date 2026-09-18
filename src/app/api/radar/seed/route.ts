// Load / reload the Event Radar DEMO dataset on demand. Every row it writes is marked is_seed=1 and
// badged "SEED" in the UI, so it can never be mistaken for verified production data. Idempotent
// (upserts by dedupe_key). Gated to users who can manage settings.

import { NextResponse } from "next/server";
import { reseedRadar } from "@/lib/radar/seed";
import { radarBoard } from "@/lib/radar/service";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await reseedRadar();
  return NextResponse.json({ ok: true, count: radarBoard().rows.length });
}
