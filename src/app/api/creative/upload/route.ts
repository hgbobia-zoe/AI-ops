// Upload a source/reference image into the Creative library. Multipart body { file }. Saves the bytes to
// the data volume (data/creative/uploads) and registers a creative_images row; returns the served path.
// Real Zoe photos uploaded here become the source of truth for PRESERVE (never a placeholder).

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { insertImage } from "@/lib/creative/store";
import { uploadDir } from "@/lib/creative/service";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml", "image/avif"]);
const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg", "image/avif": ".avif" };

export async function POST(req: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file_required" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });
  const mime = file.type || "application/octet-stream";
  if (!ALLOWED.has(mime)) return NextResponse.json({ error: "unsupported_type", mime }, { status: 415 });

  const buf = Buffer.from(await file.arrayBuffer());
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const ext = EXT[mime] || extname(file.name) || ".bin";
  const filePath = join(dir, `${randomUUID()}${ext}`);
  await writeFile(filePath, buf);

  const jobId = typeof form.get("jobId") === "string" ? String(form.get("jobId")) : null;
  const img = insertImage({
    kind: "upload",
    name: file.name || "upload",
    servedPath: "",
    filePath,
    mime,
    width: null,
    height: null,
    placeholder: false,
    jobId,
    createdBy: (await currentActor()).label,
  });
  return NextResponse.json({ ok: true, image: img });
}
