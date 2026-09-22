// Image-provider selection + config — the model-agnostic swap. GET returns a masked status of every
// provider (never a key/token value) plus the app's callback URL. POST selects the active provider and/or
// stores config: an API key for key-based providers, or the n8n webhook URL (KV) + auth token (secret).
// Owner/admin only.

import { NextResponse } from "next/server";
import { providerStatuses, setSelectedProviderId, getProviderById, PROVIDER_SECRET_KEYS } from "@/lib/creative/providers";
import { setN8nWebhookUrl, N8N_TOKEN_SECRET } from "@/lib/creative/providers/n8n";
import { setSecret } from "@/lib/secrets";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { publicOrigin } from "@/lib/http/origin";

export const dynamic = "force-dynamic";

function callbackUrl(req: Request): string {
  const origin = publicOrigin(req).replace(/\/+$/, "");
  return origin ? `${origin}/api/creative/callback` : "/api/creative/callback";
}

export function GET(req: Request): NextResponse {
  return NextResponse.json({ providers: providerStatuses(), callbackUrl: callbackUrl(req) });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { select?: string; providerId?: string; apiKey?: string; webhookUrl?: string; authToken?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.select) {
    if (!getProviderById(body.select)) return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
    setSelectedProviderId(body.select);
  }

  // n8n config: webhook URL (KV, shown in cleartext) + auth token (write-only secret).
  if (body.webhookUrl !== undefined) setN8nWebhookUrl(body.webhookUrl);
  if (body.authToken !== undefined) {
    if (body.authToken === "__clear__") setSecret(N8N_TOKEN_SECRET, "");
    else if (body.authToken.trim()) setSecret(N8N_TOKEN_SECRET, body.authToken);
    // blank = leave as-is (don't wipe a stored token from a masked form)
  }

  // Key-based providers (fal/replicate/openai-image): store/clear the single API key.
  if (body.providerId && body.apiKey !== undefined) {
    const secretKey = PROVIDER_SECRET_KEYS[body.providerId];
    if (!secretKey) return NextResponse.json({ error: "provider_has_no_key" }, { status: 400 });
    if (body.apiKey === "__clear__") setSecret(secretKey, "");
    else if (body.apiKey.trim()) setSecret(secretKey, body.apiKey);
  }

  return NextResponse.json({ ok: true, providers: providerStatuses(), callbackUrl: callbackUrl(req) });
}
