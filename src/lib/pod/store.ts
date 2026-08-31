// Proof-of-delivery file store. Photos and signatures captured on the tablet are
// saved to the persistent volume (next to the SQLite DB) and referenced by id from
// the stop. Self-hosted single container — no S3 needed; swap this module later if
// you move to object storage.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

function uploadsDir(): string {
  const dbPath = process.env.DATABASE_PATH || "./data/dispatch.db";
  const base = dbPath === ":memory:" ? "./data" : dirname(dbPath);
  const dir = join(base, "pod");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

/** Save a data URL (data:image/...;base64,....) and return its opaque id. */
export function savePodImage(dataUrl: string): string | null {
  const m = /^data:(image\/[a-z+]+);base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const ext = EXT[m[1].toLowerCase()] ?? "png";
  const id = `${randomUUID()}.${ext}`;
  writeFileSync(join(uploadsDir(), id), Buffer.from(m[2], "base64"));
  return id;
}

export interface PodFile {
  buffer: Buffer;
  contentType: string;
}

/** Read a saved POD file by id. Id is validated to a bare filename (no traversal). */
export function readPodImage(id: string): PodFile | null {
  if (!/^[a-f0-9-]+\.(png|jpg|webp)$/i.test(id)) return null;
  const path = join(uploadsDir(), id);
  if (!existsSync(path)) return null;
  const ext = id.split(".").pop()!.toLowerCase();
  const contentType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  return { buffer: readFileSync(path), contentType };
}
