// AI Control Plane — choose the active AIProvider adapter (manage level; proxy-gated owner/admin). GET
// returns the client-safe catalog (no secrets, no functions) + which is active; POST sets the active one.
// Credentials are never read or returned here — adapters that need keys use env/Fly secrets or the
// server-side secrets store, never the browser.

import { NextResponse } from "next/server";
import { aiProviderCatalog, setActiveAiProvider, aiConfigured, AI_PROVIDERS, type AiProviderId } from "@/lib/ai/provider";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ providers: aiProviderCatalog(), inlineReady: aiConfigured() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageAi(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!AI_PROVIDERS.some((p) => p.id === id)) return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
  setActiveAiProvider(id as AiProviderId);
  return NextResponse.json({ ok: true, providers: aiProviderCatalog() });
}
