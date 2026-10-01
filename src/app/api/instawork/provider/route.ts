// Instawork session cookie — the write-only provider field for /admin. Follows the SEO/creative provider
// pattern: GET reports only whether a cookie is set (never the value); POST stores or clears it (owner/admin).
// The secret key is "instawork.cookie", read by the Instawork boundary (src/lib/instawork/client.ts) to pull
// temp-labor shifts server-side. (A cookie expires periodically — re-paste it when the pull goes unverified.)

import { NextResponse } from "next/server";
import { setSecret, hasSecret } from "@/lib/secrets";
import { getInstaworkShifts } from "@/lib/instawork/client";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const SECRET_KEY = "instawork.cookie";

export function GET(): NextResponse {
  return NextResponse.json({ set: hasSecret(SECRET_KEY) });
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
    return NextResponse.json({ ok: true, set: false });
  }
  if (typeof body.token === "string" && body.token.trim()) {
    setSecret(SECRET_KEY, body.token.trim());
    // Probe once so the admin sees whether the cookie actually works (reachable + valid).
    const r = await getInstaworkShifts();
    return NextResponse.json({ ok: true, set: true, probe: { ok: r.ok, status: r.status, shifts: r.shifts.length, error: r.error ?? null } });
  }
  return NextResponse.json({ ok: true, set: hasSecret(SECRET_KEY) });
}
