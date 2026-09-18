// Marketing content calendar — list + create.

import { NextResponse } from "next/server";
import { listContent, createContent } from "@/lib/marketing/store";
import type { ContentInput } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ content: listContent() });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: ContentInput;
  try {
    body = (await req.json()) as ContentInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.title || !body.title.trim()) return NextResponse.json({ error: "title_required" }, { status: 400 });
  return NextResponse.json({ ok: true, item: createContent(body) });
}
