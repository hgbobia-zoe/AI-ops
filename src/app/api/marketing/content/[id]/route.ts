// Marketing content calendar — update + delete one.

import { NextResponse } from "next/server";
import { updateContent, deleteContent } from "@/lib/marketing/store";
import type { ContentInput } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  let body: ContentInput;
  try {
    body = (await req.json()) as ContentInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const item = updateContent(id, body);
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, item });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  return NextResponse.json({ ok: deleteContent(id) });
}
