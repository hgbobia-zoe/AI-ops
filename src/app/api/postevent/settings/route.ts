// Post-Event config — the CONFIGURABLE review destination, review-invite template, and per-stage SLA
// thresholds. GET is staff-visible; POST is owner/admin only (settings gate).

import { NextResponse } from "next/server";
import { getConfig, saveConfig } from "@/lib/postevent/store";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import type { PostEventConfig } from "@/lib/postevent/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ config: getConfig() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: Partial<PostEventConfig>;
  try {
    body = (await req.json()) as Partial<PostEventConfig>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, config: saveConfig(body) });
}
