// Purchased contact lists. GET = every list with its funnel numbers. POST = import a new list from a CSV
// { name, segment, vendor?, cost?, purchasedAt?, campaignId?, notes?, csv }. Owner/admin only (lists hold
// bought contact data and what Zoe paid). Nothing is emailed here; pushing is a separate approved step.

import { NextResponse } from "next/server";
import { importList, listSummaries, isListSegment } from "@/lib/prospecting/lists";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, lists: listSummaries() });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let b: { name?: string; segment?: string; vendor?: string; cost?: number | string | null; purchasedAt?: string; campaignId?: string; notes?: string; csv?: string };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof b.csv !== "string" || !b.csv.trim()) return NextResponse.json({ error: "add the list file or paste its rows" }, { status: 400 });
  const cost = b.cost === "" || b.cost == null ? null : Number(String(b.cost).replace(/[$,\s]/g, ""));
  try {
    const out = importList(
      {
        name: b.name ?? "",
        segment: isListSegment(b.segment) ? b.segment : (b.segment as never),
        vendor: b.vendor ?? null,
        cost,
        purchasedAt: b.purchasedAt || null,
        campaignId: b.campaignId || null,
        notes: b.notes ?? null,
      },
      b.csv,
      (await currentActor()).label,
    );
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
