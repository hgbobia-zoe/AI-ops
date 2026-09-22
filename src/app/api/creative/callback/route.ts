// n8n → us: the async image-generation callback. PUBLIC path (added to the proxy allowlist) — it carries
// NO session; it authenticates by a per-generation callback token that n8n echoes back, constant-time
// compared to the token we stored when we handed the job off. On success we persist the image, take n8n's
// generation-QA as primary, layer only our light reference-first constraint check, and advance the job to
// awaiting_approval (pass) or needs_revision (fail). Human approval still gates publishing.
//
// Expected body:
//   { generationId, token, status: "succeeded"|"failed",
//     imageUrl? | imageBase64?, mime?, model? | modelChain?[],
//     qa?: { score?, verdict?: "pass"|"fail", note?, checks?: [{label, pass, note?}] },
//     error?, meta? }

import { NextResponse } from "next/server";
import { getGeneration } from "@/lib/creative/store";
import { verifyCallbackToken, completeAsyncGeneration, type CallbackPayload } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

interface Body extends CallbackPayload {
  generationId?: string;
  token?: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const generationId = typeof body.generationId === "string" ? body.generationId : "";
  const token = typeof body.token === "string" ? body.token : "";
  if (!generationId || !token) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  // Do not reveal whether the id exists before auth: a missing generation and a bad token both read as 401
  // to an unauthenticated caller (the token IS the credential).
  if (!getGeneration(generationId) || !verifyCallbackToken(generationId, token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const status = body.status === "succeeded" || body.status === "failed" ? body.status : null;
  if (!status) return NextResponse.json({ error: "bad_status" }, { status: 400 });

  const outcome = await completeAsyncGeneration(generationId, {
    status,
    imageUrl: body.imageUrl ?? null,
    imageBase64: body.imageBase64 ?? null,
    mime: body.mime ?? null,
    model: body.model ?? null,
    modelChain: body.modelChain ?? null,
    qa: body.qa ?? null,
    error: body.error ?? null,
    meta: body.meta ?? null,
  });

  if (!outcome.ok && outcome.error) return NextResponse.json({ ok: false, error: outcome.error }, { status: outcome.error === "no_image" ? 422 : 400 });
  return NextResponse.json({ ok: true, already: outcome.already ?? false, status: outcome.job?.status ?? null });
}
