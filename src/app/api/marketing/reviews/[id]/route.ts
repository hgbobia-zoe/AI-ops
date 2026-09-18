// Marketing reviews & reputation — update + delete one.

import { NextResponse } from "next/server";
import { updateReview, deleteReview } from "@/lib/marketing/store";
import type { ReviewInput } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  let body: ReviewInput;
  try {
    body = (await req.json()) as ReviewInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const review = updateReview(id, body);
  if (!review) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, review });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  return NextResponse.json({ ok: deleteReview(id) });
}
