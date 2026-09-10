// Redeem an invite — PUBLIC (the invitee is not logged in yet). Given a valid token + a chosen username
// and password, it creates the account with the invite's role and signs them in (sets the session
// cookie), so they land straight in the app. Single-use is enforced in acceptInvite's transaction.

import { NextResponse } from "next/server";
import { acceptInvite } from "@/lib/auth/invites";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const ERR_STATUS: Record<string, number> = {
  invalid: 404,
  expired: 410,
  used: 409,
  username_taken: 409,
  weak_password: 400,
  bad_input: 400,
};

const ERR_MESSAGE: Record<string, string> = {
  invalid: "This invite link is not valid.",
  expired: "This invite has expired — ask for a new one.",
  used: "This invite has already been used.",
  username_taken: "That username is taken — pick another.",
  weak_password: "Password must be at least 8 characters.",
  bad_input: "Enter a username and password.",
};

export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.APP_SESSION_TOKEN;
  if (!secret) return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });

  let body: { token?: string; username?: string; password?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.token !== "string" || typeof body.username !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "token, username and password required" }, { status: 400 });
  }

  const result = acceptInvite(body.token, { username: body.username, password: body.password, name: body.name });
  if (!result.ok) {
    return NextResponse.json({ error: ERR_MESSAGE[result.error] ?? "Could not accept invite." }, { status: ERR_STATUS[result.error] ?? 400 });
  }

  // Sign them in immediately.
  const cookie = await signSession({ uid: result.user.id, role: result.user.role }, secret);
  const res = NextResponse.json({ ok: true, role: result.user.role, name: result.user.name || result.user.username });
  res.cookies.set(SESSION_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 90 });
  return res;
}
