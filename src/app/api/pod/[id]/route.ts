// Serve a proof-of-delivery image by id from the volume. The id is a capability
// (opaque UUID filename); readPodImage validates it against path traversal.

import { readPodImage } from "@/lib/pod/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const file = readPodImage(id);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(file.buffer), {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
