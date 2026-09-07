// Competitive Bid Review API. Given a proposed bid value (and optional event month), returns how it
// stacks up against Zoe's own comparable won/lost history. Financial data → Owner/Admin only.

import { NextResponse } from "next/server";
import { reviewBid } from "@/lib/salesos/bidService";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!canSeeFinancials(await viewerRole())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { value?: unknown; month?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const value = Number(body.value);
  if (!Number.isFinite(value) || value <= 0) {
    return NextResponse.json({ error: "value must be a positive number" }, { status: 400 });
  }
  const monthNum = Number(body.month);
  const month = Number.isInteger(monthNum) && monthNum >= 1 && monthNum <= 12 ? monthNum : undefined;

  return NextResponse.json(reviewBid(value, month));
}
