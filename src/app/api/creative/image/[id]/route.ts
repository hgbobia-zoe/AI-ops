// Serve a Creative image by id from the data volume. Reads the creative_images row, streams the on-disk
// file with its stored mime. Uploaded photos and generated placeholders both flow through here.

import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { getImageFilePath } from "@/lib/creative/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const rec = getImageFilePath(id);
  if (!rec || !rec.filePath) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const buf = await readFile(rec.filePath);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "content-type": rec.mime || "application/octet-stream",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "unreadable" }, { status: 404 });
  }
}
