// Operational-cycle config API — powers the ops-cycle editor in /admin. The operational cycle (anchor
// weekday + length in days, e.g. Thu/6 → Thu..Tue) is dimension B of Financial Intelligence (periods.ts);
// it was env/default-only with no UI. GET returns the current config (no secrets); POST (owner/admin,
// enforced server-side) validates + persists it via saveOpsCycleConfig into the settings KV — no deploy.

import { NextResponse } from "next/server";
import { opsCycleConfig, saveOpsCycleConfig } from "@/lib/finance/config";
import { DEFAULT_OPS_CYCLE } from "@/lib/finance/periods";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({ config: opsCycleConfig(), default: DEFAULT_OPS_CYCLE });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { anchorDow?: unknown; lengthDays?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const anchorDow = Number(body.anchorDow);
  const lengthDays = Number(body.lengthDays);
  if (!Number.isFinite(anchorDow) || !Number.isFinite(lengthDays)) {
    return NextResponse.json({ error: "invalid_config" }, { status: 400 });
  }
  // saveOpsCycleConfig clamps anchorDow to 0-6 and lengthDays to 1-14, so a bad value can never break
  // period math; we read back the clamped, stored value to return the truth.
  saveOpsCycleConfig({ anchorDow, lengthDays });
  return NextResponse.json({ ok: true, config: opsCycleConfig() });
}
