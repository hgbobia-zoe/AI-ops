// Server-side session accessor for pages + API route handlers (Node runtime; uses next/headers).
// When auth is DISABLED (no APP_SESSION_TOKEN), the app is open and the viewer is treated as an
// Owner (full access) — matching the pre-auth single-operator behavior. When ENABLED, the proxy
// guarantees only a valid session reaches a protected page, so a null here on a gated route can't
// happen; callers still default safely.

import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE, type Session } from "./session";
import { getUser } from "./users";
import { initialsOf } from "@/lib/salesos/noteFormat";
import type { Role } from "./roles";

export function authEnabled(): boolean {
  return Boolean(process.env.APP_SESSION_TOKEN);
}

export async function getSession(): Promise<Session | null> {
  const secret = process.env.APP_SESSION_TOKEN;
  if (!secret) return null;
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySession(value, secret);
}

/** The viewer's effective role. Auth off → "owner" (full access). Auth on → the session's role. */
export async function viewerRole(): Promise<Role> {
  if (!authEnabled()) return "owner";
  return (await getSession())?.role ?? "member";
}

/** The signed-in rep's initials (for tagging automated Goodshuffle notes), or null when unknown
 *  (auth disabled, or no name on the account) — callers fall back to a generic "SalesOS" tag. */
export async function viewerInitials(): Promise<string | null> {
  const s = await getSession();
  if (!s) return null;
  try {
    return initialsOf(getUser(s.uid)?.name ?? null);
  } catch {
    return null;
  }
}

/** The signed-in rep's FIRST name (for personalizing outreach: "Hi Ivy, this is Sarah..."), or null
 *  when unknown (auth off, or no name on file) — callers fall back to "it's Zoe Events". */
export async function viewerFirstName(): Promise<string | null> {
  const s = await getSession();
  if (!s) return null;
  try {
    const name = getUser(s.uid)?.name?.trim();
    return name ? name.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
}

/** The signed-in rep's linked Quo/OpenPhone user id, or null — so a text they send is attributed to
 *  them in Quo AND tagged with their initials, automatically, without a per-message picker. */
export async function viewerQuoUserId(): Promise<string | null> {
  const s = await getSession();
  if (!s) return null;
  try {
    return getUser(s.uid)?.openphoneUserId ?? null;
  } catch {
    return null;
  }
}

/** The viewer bundle the lead side panel needs (name for "sends as", linked Quo id, initials). One
 *  call for every view (worklist/table/board) so they open the same full lead panel. */
export async function viewerForPanel(): Promise<{ name: string; quoUserId: string | null; initials: string }> {
  const [actor, quo, initials] = await Promise.all([currentActor(), viewerQuoUserId(), viewerInitials()]);
  return { name: actor.label, quoUserId: quo, initials: initials ?? "" };
}

export interface Actor {
  id: string; // user id, or "anon" when login is off
  label: string; // human name for the audit trail
}

/** Who is performing an action, for the sales audit trail. When login is OFF we genuinely don't know
 *  who — so we say "Unattributed", never a fabricated name. When ON, the signed-in user. */
export async function currentActor(): Promise<Actor> {
  if (!authEnabled()) return { id: "anon", label: "Unattributed (login off)" };
  const s = await getSession();
  if (!s) return { id: "anon", label: "Unattributed" };
  // A Shift Pass holder isn't in the users table — attribute to the contractor's name on the pass.
  if (s.role === "guest") return { id: s.uid, label: s.name?.trim() ? `${s.name.trim()} (Shift Pass)` : "Shift Pass" };
  try {
    const u = getUser(s.uid);
    return { id: s.uid, label: u?.name?.trim() || u?.username || s.uid };
  } catch {
    return { id: s.uid, label: s.uid };
  }
}
