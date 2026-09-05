// Serve a proof-of-delivery image by id from the volume. The id is a capability
// (opaque UUID filename); readPodImage validates it against path traversal.
//
// CORS-open to the Goodshuffle origin: the outbox drainer (running inside the
// logged-in Goodshuffle session) fetches these bytes to push the delivery photo
// into the project's Files tab. The id is an unguessable capability, so a bare
// GET is the whole access check — same trust model as /api/gs/outbox.

import { readPodImage } from "@/lib/pod/store";

export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "https://pro.goodshuffle.com", Vary: "Origin" };

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const file = readPodImage(id);
  if (!file) return new Response("Not found", { status: 404, headers: CORS });
  return new Response(new Uint8Array(file.buffer), {
    headers: {
      ...CORS,
      "Content-Type": file.contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
