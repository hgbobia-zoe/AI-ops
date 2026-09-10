// One-time invite links (Node runtime). An owner/admin mints an invite for a role; the invitee opens
// /join?token=… and sets their OWN username + password — the creator never handles a password. Invites
// are single-use and expire. No email is stored; the link is shared however the team likes.

import { randomBytes } from "node:crypto";
import { getDb } from "@/lib/db";
import { isRole, type Role } from "./roles";
import { createUser, usernameExists, type User } from "./users";

const INVITE_TTL_DAYS = 7;

export interface Invite {
  token: string;
  role: Role;
  name: string | null;
  invitedBy: string | null;
  invitedByName: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedUserId: string | null;
}

interface Row {
  token: string;
  role: string;
  name: string | null;
  invited_by: string | null;
  invited_by_name: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_user_id: string | null;
}

function toInvite(r: Row): Invite {
  return {
    token: r.token,
    role: isRole(r.role) ? r.role : "member",
    name: r.name,
    invitedBy: r.invited_by,
    invitedByName: r.invited_by_name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    acceptedUserId: r.accepted_user_id,
  };
}

/** Mint an invite for a role. Returns the invite (its `token` goes in the /join link). */
export function createInvite(input: { role: Role; name?: string; invitedBy?: string; invitedByName?: string }): Invite {
  const token = randomBytes(24).toString("base64url"); // ~32 url-safe chars
  const now = new Date();
  const expires = new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000);
  getDb()
    .prepare(
      `INSERT INTO invites (token, role, name, invited_by, invited_by_name, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(token, input.role, input.name?.trim() || null, input.invitedBy ?? null, input.invitedByName ?? null, now.toISOString(), expires.toISOString());
  return toInvite(getDb().prepare("SELECT * FROM invites WHERE token = ?").get(token) as Row);
}

export function getInvite(token: string): Invite | null {
  const r = getDb().prepare("SELECT * FROM invites WHERE token = ?").get(token) as Row | undefined;
  return r ? toInvite(r) : null;
}

export type InviteState = "valid" | "not_found" | "expired" | "used";

/** Classify an invite for the /join page (without leaking why beyond these states). */
export function inviteState(token: string): { state: InviteState; invite: Invite | null } {
  const invite = getInvite(token);
  if (!invite) return { state: "not_found", invite: null };
  if (invite.acceptedAt) return { state: "used", invite };
  if (Date.parse(invite.expiresAt) < Date.now()) return { state: "expired", invite };
  return { state: "valid", invite };
}

/** Pending (unaccepted, unexpired) invites, newest first — for the Team screen. */
export function listPendingInvites(): Invite[] {
  const now = new Date().toISOString();
  return (getDb().prepare("SELECT * FROM invites WHERE accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(now) as Row[]).map(toInvite);
}

export function revokeInvite(token: string): boolean {
  return getDb().prepare("DELETE FROM invites WHERE token = ? AND accepted_at IS NULL").run(token).changes > 0;
}

export type AcceptResult =
  | { ok: true; user: User }
  | { ok: false; error: "invalid" | "expired" | "used" | "username_taken" | "weak_password" | "bad_input" };

/** Redeem an invite: create the account with the invite's role and mark the invite used. Single-use —
 *  guarded in a transaction so a token can't be redeemed twice. */
export function acceptInvite(token: string, input: { username: string; password: string; name?: string }): AcceptResult {
  const username = (input.username ?? "").trim();
  if (!username || typeof input.password !== "string") return { ok: false, error: "bad_input" };
  if (input.password.length < 8) return { ok: false, error: "weak_password" };

  const db = getDb();
  const tx = db.transaction((): AcceptResult => {
    const r = db.prepare("SELECT * FROM invites WHERE token = ?").get(token) as Row | undefined;
    if (!r) return { ok: false, error: "invalid" };
    if (r.accepted_at) return { ok: false, error: "used" };
    if (Date.parse(r.expires_at) < Date.now()) return { ok: false, error: "expired" };
    if (usernameExists(username)) return { ok: false, error: "username_taken" };

    const role = (isRole(r.role) ? r.role : "member") as Role;
    const user = createUser({ username, name: input.name?.trim() || r.name || undefined, role, password: input.password });
    db.prepare("UPDATE invites SET accepted_at = ?, accepted_user_id = ? WHERE token = ?").run(new Date().toISOString(), user.id, token);
    return { ok: true, user };
  });

  try {
    return tx();
  } catch {
    // Unique-constraint race (username claimed between check and insert) etc.
    return { ok: false, error: "username_taken" };
  }
}
