// Approved push of a purchased list to the cold email tool (Instantly or Smartlead, whichever is active).
// POST { contactIds?: string[], allReady?: boolean, verify?: boolean }. allReady = every contact that passes
// the screen right now, up to MAX_PUSH. Contacts are re-screened server side either way. Owner/admin only.
// The app never sends email itself.

import { NextResponse } from "next/server";
import { pushListContacts, screenedContacts, getList, MAX_PUSH } from "@/lib/prospecting/lists";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!getList(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  let b: { contactIds?: unknown; allReady?: boolean; verify?: boolean };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const ids = b.allReady
    ? screenedContacts(id).filter((c) => c.eligible).slice(0, MAX_PUSH).map((c) => c.id)
    : Array.isArray(b.contactIds) ? b.contactIds.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return NextResponse.json({ error: "nobody is ready to send" }, { status: 400 });
  const result = await pushListContacts(id, ids, (await currentActor()).label, { verify: b.verify !== false });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
