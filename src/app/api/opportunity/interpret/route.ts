// Generate (or return cached) AI interpretation for an opportunity — plain-language summary, why it's
// relevant, and research actions. Deterministic template floor always; LLM refine when configured.
// Proxy-gated to signed-in console users.

import { NextResponse } from "next/server";
import { interpretOpportunity } from "@/lib/opportunity/interpret";
import { getOpportunity } from "@/lib/opportunity/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string; force?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id || !getOpportunity(id)) return NextResponse.json({ error: "opportunity not found" }, { status: 404 });
  const summary = await interpretOpportunity(id, { force: !!body.force });
  return NextResponse.json({ ok: true, summary });
}
