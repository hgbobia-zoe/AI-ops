// Log what came back from a purchased-list contact. POST { outcome: replied | interested | not_interested |
// bounced | unsubscribed }. Negative outcomes join the do-not-contact list; interested creates a Radar
// opportunity (stage Engaged) for the intent-confirmed Goodshuffle conversion. Owner/admin only.

import { NextResponse } from "next/server";
import { logListOutcome, LIST_OUTCOMES, type ListOutcome } from "@/lib/prospecting/lists";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ contactId: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { contactId } = await params;
  let b: { outcome?: string };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!LIST_OUTCOMES.includes(b.outcome as ListOutcome)) return NextResponse.json({ error: "unknown outcome" }, { status: 400 });
  const r = logListOutcome(contactId, b.outcome as ListOutcome, (await currentActor()).label);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "not found" ? 404 : 400 });
  return NextResponse.json(r);
}
