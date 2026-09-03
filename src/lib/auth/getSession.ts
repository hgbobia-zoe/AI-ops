// Server-side session accessor for pages + API route handlers (Node runtime; uses next/headers).
// When auth is DISABLED (no APP_SESSION_TOKEN), the app is open and the viewer is treated as an
// Owner (full access) — matching the pre-auth single-operator behavior. When ENABLED, the proxy
// guarantees only a valid session reaches a protected page, so a null here on a gated route can't
// happen; callers still default safely.

import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE, type Session } from "./session";
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
