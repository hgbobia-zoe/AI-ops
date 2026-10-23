// Website Studio — screenshot artifact storage on the Fly volume. The runner uploads preview screenshots
// (PNG) via the token-gated runner artifact route; the blade reads them back via the authed artifact route.
// Bytes live next to the SQLite DB on the persistent volume (dirname(DATABASE_PATH)/website-artifacts), so
// they survive restarts exactly like the DB. These are PREVIEW images of a local DevKinsta render, never the
// live site.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

function artifactsRoot(): string {
  const dbPath = process.env.DATABASE_PATH || "./data/dispatch.db";
  // ":memory:" (tests) has no directory — fall back to ./data so the path is still well-formed.
  const base = dbPath === ":memory:" ? "./data" : dirname(dbPath);
  return join(base, "website-artifacts");
}

/** Lowercase, collapse anything non [a-z0-9-_] to a dash. Keeps a job id / label safe as a path segment
 *  (no traversal, no separators). PURE. */
export function safeSegment(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "x";
}

/** The on-disk file for a job's labelled screenshot. */
function artifactFile(jobId: string, label: string): string {
  return join(artifactsRoot(), safeSegment(jobId), `${safeSegment(label)}.png`);
}

/** Save a screenshot's bytes for (jobId, label). Returns the stored basename (the `path` recorded on the
 *  job's artifacts). Throws on IO failure — callers wrap it. */
export function saveArtifact(jobId: string, label: string, bytes: Buffer): string {
  const file = artifactFile(jobId, label);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return `${safeSegment(label)}.png`;
}

/** Read a screenshot's bytes for (jobId, label), or null if it isn't on the volume. */
export function readArtifact(jobId: string, label: string): Buffer | null {
  try {
    const file = artifactFile(jobId, label);
    if (!existsSync(file)) return null;
    return readFileSync(file);
  } catch {
    return null;
  }
}
