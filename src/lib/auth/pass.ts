// Shift Pass domain logic: mint an unguessable token, judge a pass's live status, and turn a live
// pass into a scoped guest Session. Node-only (uses node:crypto) — imported by the /pass gateway and
// the /api/passes handlers, never the Edge proxy (which only verifies the signed cookie).

import { randomBytes } from "node:crypto";
import type { ShiftPass } from "@/lib/db/repo";
import type { Session } from "./session";

export type PassStatus = "active" | "expired" | "revoked";

/** A URL-safe, unguessable token (~192 bits). This IS the pass id and the /pass/<token> segment. */
export function newPassToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Where a pass stands right now. Revoked beats expired (an admin killed it deliberately). */
export function passStatus(p: ShiftPass, now: number = Date.now()): PassStatus {
  if (p.revokedAt) return "revoked";
  if (Date.parse(p.expiresAt) <= now) return "expired";
  return "active";
}

export function isPassLive(p: ShiftPass | null, now: number = Date.now()): p is ShiftPass {
  return !!p && passStatus(p, now) === "active";
}

/** The scoped session a live pass grants. exp mirrors the pass's own expiry (epoch seconds) so the
 *  cookie self-destructs at the shift's end even if the DB is never consulted. uid = pass:<token>. */
export function passSession(p: ShiftPass): Session {
  return { uid: `pass:${p.id}`, role: "guest", exp: Math.floor(Date.parse(p.expiresAt) / 1000), name: p.name };
}

/** Recover the pass token from a guest session's uid (`pass:<token>`), or null. */
export function passIdFromUid(uid: string | undefined | null): string | null {
  if (!uid || !uid.startsWith("pass:")) return null;
  return uid.slice("pass:".length) || null;
}
