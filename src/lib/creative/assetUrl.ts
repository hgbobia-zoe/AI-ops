// Short-lived signed URLs for Creative source/reference images. n8n runs off-box and must DOWNLOAD the
// source photo to do a reference-first edit, but the image route is session-gated — n8n carries no session.
// Rather than make private customer/event imagery publicly enumerable, we hand n8n a signed, EXPIRING URL:
//   /api/creative/image/<id>?exp=<epoch_ms>&sig=<hmac>
// The proxy verifies the signature and lets ONLY a valid, unexpired request through (see src/proxy.ts).
//
// HMAC-SHA256 via Web Crypto ONLY (no node:crypto) so this module is safe in the Edge proxy AND in Node
// route handlers. Signing key = APP_SESSION_TOKEN (the same server-only secret the session cookie uses, and
// the only secret the edge proxy can read). If APP_SESSION_TOKEN is unset the whole auth gate is disabled
// anyway (dev), so signing is a best-effort no-op there.

const enc = new TextEncoder();

/** Default lifetime for a signed source URL. Generous: an async n8n run may queue behind other executions,
 *  daisy-chain several models, and retry internally before it fetches the source. */
export const SOURCE_URL_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function secret(): string | null {
  const s = process.env.APP_SESSION_TOKEN?.trim();
  return s ? s : null;
}

/** Sign `<id>:<exp>`. Returns the b64url signature, or null when no signing key is configured. */
async function sign(id: string, exp: number): Promise<string | null> {
  const s = secret();
  if (!s) return null;
  const key = await hmacKey(s);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}:${exp}`) as BufferSource));
  return bytesToB64url(sig);
}

/** Build a signed, expiring path for an image id: `/api/creative/image/<id>?exp=&sig=`. When no signing key
 *  is set (gate disabled), returns the bare path — it is already reachable without auth in that mode. */
export async function signImagePath(id: string, ttlMs: number = SOURCE_URL_TTL_MS): Promise<string> {
  const base = `/api/creative/image/${encodeURIComponent(id)}`;
  const exp = Date.now() + Math.max(0, ttlMs);
  const sig = await sign(id, exp);
  return sig ? `${base}?exp=${exp}&sig=${sig}` : base;
}

/** Verify a signature for an image id. Rejects on expiry, tampering, or malformed input. Used by the proxy
 *  to let an unauthenticated-but-signed n8n fetch through, without exposing every image publicly. */
export async function verifyImageSig(id: string, expRaw: string | null, sig: string | null): Promise<boolean> {
  if (!id || !expRaw || !sig) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  const s = secret();
  if (!s) return false;
  try {
    const key = await hmacKey(s);
    return await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig) as BufferSource, enc.encode(`${id}:${exp}`) as BufferSource);
  } catch {
    return false;
  }
}
