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

  const submittedPhotos = body.photos ?? [];
  const photoIds: string[] = [];
  for (const dataUrl of submittedPhotos) {
    const id = savePodImage(dataUrl);
    if (id) photoIds.push(id);
  }
  const signatureId = body.signature ? savePodImage(body.signature) ?? undefined : undefined;

  // Proof-of-delivery is not something to silently lose. If any submitted image failed to save,
  // fail the request (with what DID save) so the caller can retry rather than mark the stop done
  // with missing proof.
  const photosLost = submittedPhotos.length - photoIds.length;
  const signatureLost = Boolean(body.signature) && !signatureId;
  if (photosLost > 0 || signatureLost) {
    return NextResponse.json(
      { error: "pod_save_incomplete", photosLost, signatureLost, photoIds, signatureId },
      { status: 502 },
    );
  }

  return NextResponse.json({ photoIds, signatureId });
}
