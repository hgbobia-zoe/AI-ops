// AI Control Plane — per-blade AI config (manage level; proxy-gated owner/admin). GET returns every blade's
// config; POST merges a patch into one blade. These toggles only decide whether AI interprets/proposes on
// a blade — they can never let it execute (execution stays behind the approval + outbox + send-gate path).

import { NextResponse } from "next/server";
import { allBladeAiConfig, setBladeAiConfig, isValidBlade, type BladeAiConfig } from "@/lib/ai/bladeConfig";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ blades: allBladeAiConfig() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { blade?: string; enabled?: boolean; autoPropose?: boolean; provider?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const blade = (body.blade ?? "").trim();
  if (!isValidBlade(blade)) return NextResponse.json({ error: "unknown_blade" }, { status: 400 });
  const patch: Partial<BladeAiConfig> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.autoPropose === "boolean") patch.autoPropose = body.autoPropose;
  if (typeof body.provider === "string") patch.provider = body.provider.trim() || undefined;
  const next = setBladeAiConfig(blade, patch);
  return NextResponse.json({ ok: true, blade, config: next });
}
