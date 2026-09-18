// Route an opportunity into the prospecting motion (tier → cadence → tasks). Does NOT touch Goodshuffle.
// Proxy-gated + attributed.

import { NextResponse } from "next/server";
import { enroll } from "@/lib/prospecting/service";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { opportunityId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.opportunityId ?? "").trim();
  if (!id) return NextResponse.json({ error: "opportunityId required" }, { status: 400 });
  const actor = (await currentActor()).label;
  const result = await enroll(id, actor);
  if (!result.ok) return NextResponse.json({ error: result.error ?? "could not enroll", ...result }, { status: 400 });
  return NextResponse.json(result);
}
