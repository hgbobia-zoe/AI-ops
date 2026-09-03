// Login / logout for the per-person access matrix. Verifies username + password against the users
// table, then sets a SIGNED session cookie carrying {uid, role} (tamper-proof — a Member can't
// forge Owner). Gate is active once APP_SESSION_TOKEN (the signing secret) is set.

import { NextResponse } from "next/server";
import { verifyLogin, bootstrapOwner } from "@/lib/auth/users";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.APP_SESSION_TOKEN;
  if (!secret) return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });

  bootstrapOwner(); // seed the first Owner from env if the users table is empty

  let body: { username?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "username_and_password_required" }, { status: 400 });
  }

  const user = verifyLogin(body.username, body.password);
  if (!user) return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });

  const cookie = await signSession({ uid: user.id, role: user.role }, secret);
  const res = NextResponse.json({ ok: true, role: user.role, name: user.name || user.username });
  res.cookies.set(SESSION_COOKIE, cookie, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });
  return res;
}

export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
