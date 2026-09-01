// Test a provider's stored credentials — the /admin "Test connection" button. Runs the
// provider's own lightweight authenticated call and reports ok / error. Uses the
// currently-STORED credentials (save first, then test). Admin-code gated.

import { NextResponse } from "next/server";
import {
  smsProviderById,
  gpsProviderById,
  loadSmsConfig,
  loadGpsConfig,
  SMS_PROVIDERS,
} from "@/lib/providers";

export const dynamic = "force-dynamic";

function adminPin(): string {
  return process.env.ADMIN_PIN || process.env.NEXT_PUBLIC_ADMIN_PIN || "0000";
}

// OpenPhone can still fall back to env creds (parity with the send path).
function withEnvFallback(providerId: string, cfg: Record<string, string>): Record<string, string> {
  if (providerId === "openphone") {
    return {
      apiKey: cfg.apiKey || process.env.OPENPHONE_API_KEY || "",
      fromNumber: cfg.fromNumber || process.env.OPENPHONE_FROM || "",
    };
  }
  return cfg;
}

export async function POST(req: Request): Promise<NextResponse> {
  if ((req.headers.get("x-admin-pin") || "") !== adminPin()) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { kind?: string; provider?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    if (body.kind === "sms") {
      const isKnown = SMS_PROVIDERS.some((p) => p.id === body.provider);
      if (!isKnown) return NextResponse.json({ error: "unknown provider" }, { status: 400 });
      const p = smsProviderById(body.provider!);
      const res = await p.test(withEnvFallback(p.id, loadSmsConfig(p.id)));
      return NextResponse.json(res);
    }
    if (body.kind === "gps") {
      const p = gpsProviderById(body.provider!);
      if (p.id !== body.provider) return NextResponse.json({ error: "unknown provider" }, { status: 400 });
      const res = await p.test(loadGpsConfig(p.id));
      return NextResponse.json(res);
    }
    return NextResponse.json({ error: "kind must be sms or gps" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 200 });
  }
}
