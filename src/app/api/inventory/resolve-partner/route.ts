// POST /api/inventory/resolve-partner — turn a pasted "partner's rental inventory link" into a storefront
// vendor token. Owner/admin only (canManageSettings), matching the rest of /api/inventory.
//
// Body: { input: string } — a storefront page URL, a data.goodshuffle.com/vendor/<token> URL, OR a bare
// token. Returns { ok, token?, source: "url"|"dataUrl"|"token"|"none", reason? }. Never throws: a page fetch
// that fails (timeout, non-200, or a Wix page with no token in the static HTML) comes back ok:false + reason
// so the UI can prompt the operator to paste the data link / token directly.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { resolvePartnerToken } from "@/lib/inventory/resolvePartner";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ ok: false, source: "none", reason: "forbidden" }, { status: 403 });

  let body: { input?: unknown };
  try {
    body = (await req.json()) as { input?: unknown };
  } catch {
    return NextResponse.json({ ok: false, source: "none", reason: "invalid_json" }, { status: 400 });
  }

  const input = typeof body?.input === "string" ? body.input : "";
  const result = await resolvePartnerToken(input);
  return NextResponse.json(result);
}
