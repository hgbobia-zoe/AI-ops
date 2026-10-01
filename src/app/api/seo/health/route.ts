// GET /api/seo/health — refresh + return the Ubersuggest integration health. Owner/admin only (gated in
// the proxy alongside the rest of /api/seo). Running the LIVE probe here (not on page render) keeps the
// Overview cheap: the page reads stored diagnostics, this endpoint actually contacts the MCP server.
//
// When no credential is configured, probe() short-circuits and returns the honest not_configured status
// with NO network call — it never fabricates a connection.

import { NextResponse } from "next/server";
import { probe, getHealth } from "@/lib/seo/ubersuggest";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const force = new URL(req.url).searchParams.get("force") === "1";
  try {
    const health = await probe({ force });
    return NextResponse.json({ health, at: new Date().toISOString() });
  } catch {
    // probe() is defensive and shouldn't throw, but never let the endpoint 500 — return last-known health.
    return NextResponse.json({ health: getHealth(), at: new Date().toISOString() }, { status: 200 });
  }
}
