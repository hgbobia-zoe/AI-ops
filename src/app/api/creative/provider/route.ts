// Image-provider selection + API key — the model-agnostic swap. GET returns a masked status of every
// provider (never a key value). POST selects the active provider and/or stores a provider's API key
// (write-only secret pattern). Owner/admin only.

import { NextResponse } from "next/server";
import { providerStatuses, setSelectedProviderId, getProviderById, PROVIDER_SECRET_KEYS } from "@/lib/creative/providers";
import { setSecret } from "@/lib/secrets";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({ providers: providerStatuses() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { select?: string; providerId?: string; apiKey?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.select) {
    if (!getProviderById(body.select)) return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
    setSelectedProviderId(body.select);
  }
  // Store/clear a provider's key. Blank leaves it as-is; "__clear__" removes it.
  if (body.providerId && body.apiKey !== undefined) {
    const secretKey = PROVIDER_SECRET_KEYS[body.providerId];
    if (!secretKey) return NextResponse.json({ error: "provider_has_no_key" }, { status: 400 });
    if (body.apiKey === "__clear__") setSecret(secretKey, "");
    else if (body.apiKey.trim()) setSecret(secretKey, body.apiKey);
  }
  return NextResponse.json({ ok: true, providers: providerStatuses() });
}
