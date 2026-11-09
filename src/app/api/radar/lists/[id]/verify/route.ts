// Email check for a purchased list (bounce protection before any push). POST checks the next batch of
// addresses that wait only for their check: free domain check, then Instantly's verifier (1 credit per
// address). The page calls again until `remaining` is 0. Owner/admin only. Nothing is emailed here.

import { NextResponse } from "next/server";
import { verifyListContacts, getList } from "@/lib/prospecting/lists";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!getList(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const run = await verifyListContacts(id, (await currentActor()).label);
  return NextResponse.json(run, { status: run.ok ? 200 : 400 });
}
