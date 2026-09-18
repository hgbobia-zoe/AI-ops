// Marketing reviews & reputation — list + create.

import { NextResponse } from "next/server";
import { listReviews, createReview } from "@/lib/marketing/store";
import type { ReviewInput } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ reviews: listReviews() });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: ReviewInput;
  try {
    body = (await req.json()) as ReviewInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, review: createReview(body) });
}
