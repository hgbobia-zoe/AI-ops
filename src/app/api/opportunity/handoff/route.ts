// Opportunity Radar → Goodshuffle conversion, INTENT ONLY. A person confirms the prospect's intent
// (replied interested, meeting booked, asked for a quote) and the contact; then a Goodshuffle project is
// queued through the existing create_project pipeline, or the contact's existing project is linked.
// Never automatic. Attributed to the signed-in person and audited. See src/lib/opportunity/conversion.ts.

import { NextResponse } from "next/server";
import { convertOpportunity, type IntentKind } from "@/lib/opportunity/conversion";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let body: { id?: string; intent?: { kind?: string; note?: string }; contact?: Partial<Record<"firstName" | "lastName" | "email" | "phone", string>> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const res = convertOpportunity({
    opportunityId: id,
    intent: { kind: s(body.intent?.kind, 40) as IntentKind, note: s(body.intent?.note, 300) },
    contact: { firstName: s(body.contact?.firstName, 80), lastName: s(body.contact?.lastName, 80), email: s(body.contact?.email, 160), phone: s(body.contact?.phone, 40) },
    actor: (await currentActor()).label,
  });
  if (!res.ok) return NextResponse.json(res, { status: res.error === "opportunity not found" ? 404 : 400 });
  return NextResponse.json(res);
}
