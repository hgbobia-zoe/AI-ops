// POST /api/seo/discover — run the SEO opportunity discovery pipeline on demand (the "Discover" button).
// Owner/admin only (gated in the proxy alongside the rest of /api/seo; re-checked here defensively).
//
// With no Ubersuggest MCP credential this returns an honest "not configured, nothing discovered" summary and
// makes NO network call — it never fabricates opportunities.

import { NextResponse } from "next/server";
import { discover } from "@/lib/seo/discovery";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { maxGeosPerCategory?: number; categories?: string[]; limit?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body is fine */
  }
  const result = await discover({ maxGeosPerCategory: body.maxGeosPerCategory, categories: body.categories, limit: body.limit });
  return NextResponse.json({ ok: true, result });
}
