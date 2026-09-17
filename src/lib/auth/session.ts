// Signed session token — carries {uid, role} in a tamper-proof cookie so a Member can't forge an
// Owner role. HMAC-SHA256 via Web Crypto ONLY (no node:crypto import) so this module is safe in the
// Edge proxy AND in Node server components. Signing key = APP_SESSION_TOKEN.

import { isRole, type Role } from "./roles";

export const SESSION_COOKIE = "zoe_session";

export interface Session {
  uid: string;
  role: Role;
  /** Hard expiry, epoch SECONDS. Set on Shift Pass (guest) sessions so they self-destruct at the end
   *  of the shift, tamper-proof (it's inside the signature). Absent on staff logins — they don't expire
   *  server-side (the cookie's own maxAge handles staff). verifySession rejects once past. */
  exp?: number;
  /** Display name for attribution when uid isn't a real user (guest = the contractor's name). */
  name?: string;
}

const enc = new TextEncoder();

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

/** Produce `<payloadB64url>.<sigB64url>`. exp/name are included only when set, so staff cookies are
 *  byte-for-byte unchanged (back-compatible with tokens signed before these fields existed). */
export async function signSession(sess: Session, secret: string): Promise<string> {
  const claims: Session = { uid: sess.uid, role: sess.role };
  if (typeof sess.exp === "number") claims.exp = sess.exp;
  if (sess.name) claims.name = sess.name;
  const payload = bytesToB64url(enc.encode(JSON.stringify(claims)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload) as BufferSource));
  return `${payload}.${bytesToB64url(sig)}`;
}

/** Verify signature + shape; null on any tampering/malformation. */
export async function verifySession(cookieValue: string | undefined, secret: string): Promise<Session | null> {
  if (!cookieValue) return null;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return null;
  const payload = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig) as BufferSource, enc.encode(payload) as BufferSource);
    if (!ok) return null;
    const obj = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as unknown;
    if (obj && typeof obj === "object" && typeof (obj as Session).uid === "string" && isRole((obj as Session).role)) {
      const s = obj as Session;
      // Hard expiry (Shift Pass): a valid signature past its exp is a dead session. Edge-safe, no DB.
      if (typeof s.exp === "number" && s.exp * 1000 <= Date.now()) return null;
      const out: Session = { uid: s.uid, role: s.role };
      if (typeof s.exp === "number") out.exp = s.exp;
      if (typeof s.name === "string") out.name = s.name;
      return out;
    }
  } catch {
    /* fall through */
  }
  return null;
}
