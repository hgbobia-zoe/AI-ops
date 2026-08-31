// Proof-of-delivery upload. The tablet POSTs captured photos + signature as data
// URLs; we save them to the volume and return opaque ids, which the completion
// action then attaches to the stop.

import { NextResponse } from "next/server";
import { savePodImage } from "@/lib/pod/store";

export const dynamic = "force-dynamic";
// Photos can be a few MB each; allow a generous body.
export const maxDuration = 30;

export async function POST(req: Request): Promise<NextResponse> {
  let body: { photos?: string[]; signature?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const photoIds: string[] = [];
  for (const dataUrl of body.photos ?? []) {
    const id = savePodImage(dataUrl);
    if (id) photoIds.push(id);
  }
  const signatureId = body.signature ? savePodImage(body.signature) ?? undefined : undefined;

  return NextResponse.json({ photoIds, signatureId });
}
