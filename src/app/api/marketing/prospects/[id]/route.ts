// Outreach prospects — update + delete one.

import { NextResponse } from "next/server";
import { updateProspect, deleteProspect } from "@/lib/marketing/store";
import type { ProspectInput } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  let body: ProspectInput;
  try {
    body = (await req.json()) as ProspectInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const prospect = updateProspect(id, body);
  if (!prospect) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, prospect });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  return NextResponse.json({ ok: deleteProspect(id) });
}
