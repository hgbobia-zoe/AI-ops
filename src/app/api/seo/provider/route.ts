// Ubersuggest MCP credential — the provider-secret field for /admin. Follows the creative/provider pattern:
// WRITE-ONLY. GET returns only whether the credential is set (never the value) plus the current health; POST
// stores or clears the secret (owner/admin only). The secret key is "ubersuggest.mcpToken", already read by
// the boundary (src/lib/seo/ubersuggest.ts).

import { NextResponse } from "next/server";
import { setSecret, hasSecret } from "@/lib/secrets";
import { getHealth, probe } from "@/lib/seo/ubersuggest";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const SECRET_KEY = "ubersuggest.mcpToken";

export function GET(): NextResponse {
  return NextResponse.json({ set: hasSecret(SECRET_KEY), health: getHealth() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { token?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.token === "__clear__") {
    setSecret(SECRET_KEY, "");
    return NextResponse.json({ ok: true, set: false, health: getHealth() });
  }
  if (typeof body.token === "string" && body.token.trim()) {
    setSecret(SECRET_KEY, body.token);
    // Credential just set → probe once so the Overview flips from "Not checked" to the real state.
    let health = getHealth();
    try {
      health = await probe({ force: true });
    } catch {
      /* probe is defensive; keep last-known health */
    }
    return NextResponse.json({ ok: true, set: true, health });
  }
  // Blank = leave as-is (don't wipe a stored token from a masked form).
  return NextResponse.json({ ok: true, set: hasSecret(SECRET_KEY), health: getHealth() });
}
