// Gusto remote-browser push — live screenshot storage on the Fly volume. The office runner uploads the
// CURRENT frame of its Gusto browser (PNG) via the token-gated runner artifact route; the /payroll Gusto
// Console reads it back via the authed screenshot route and refreshes it with a cache-busting nonce, so the
// pane shows the remote browser live. One frame per job, overwritten each upload (not a gallery). Bytes live
// next to the SQLite DB on the persistent volume (dirname(DATABASE_PATH)/gusto-push-artifacts) so they survive
// restarts like the DB. These are screenshots of the office machine's own logged-in Gusto session.

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

function artifactsRoot(): string {
  const dbPath = process.env.DATABASE_PATH || "./data/dispatch.db";
  const base = dbPath === ":memory:" ? "./data" : dirname(dbPath);
  return join(base, "gusto-push-artifacts");
}

/** Lowercase, collapse anything unsafe to a dash — keeps a job id safe as a path segment (no traversal). PURE. */
function safeSegment(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "x";
}

function liveFile(jobId: string): string {
  return join(artifactsRoot(), safeSegment(jobId), "live.png");
}

/** Save the latest live frame for a job. Write-then-rename so a concurrent read never sees a half-written PNG.
 *  Returns the stored basename ("live.png"). Throws on IO failure — callers wrap it. */
export function saveLiveFrame(jobId: string, bytes: Buffer): string {
  const file = liveFile(jobId);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file); // atomic replace on the same volume
  return "live.png";
}

/** Read the latest live frame for a job, or null if none has been uploaded yet. Never throws. */
export function readLiveFrame(jobId: string): Buffer | null {
  try {
    const file = liveFile(jobId);
    if (!existsSync(file)) return null;
    return readFileSync(file);
  } catch {
    return null;
  }
}
