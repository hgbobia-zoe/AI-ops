// Read + save the Zoe Capability Profile (Admin → Capability Profile). Owner/Admin only (proxy gates
// /api/pursuit as settings). Facts only; nothing is generated here.

import { NextResponse } from "next/server";
import { getCapabilityProfile, saveCapabilityProfile, profileCompleteness, type CapabilityProfile } from "@/lib/pursuit/capabilityProfile";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const profile = getCapabilityProfile();
  return NextResponse.json({ profile, completeness: profileCompleteness(profile) });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: CapabilityProfile;
  try {
    body = (await req.json()) as CapabilityProfile;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const profile = saveCapabilityProfile(body);
  return NextResponse.json({ ok: true, profile, completeness: profileCompleteness(profile) });
}
