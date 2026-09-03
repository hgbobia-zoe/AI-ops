// Site-wide password gate — login/logout. A single shared password (APP_PASSWORD) proves access;
// on success we set an HttpOnly session cookie holding APP_SESSION_TOKEN (a long random secret,
// never the password). Middleware checks the cookie on every protected route. The gate is INACTIVE
// until both secrets are set (so it can't lock anyone out before it's provisioned).

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export const SESSION_COOKIE = "zoe_session";

export async function POST(req: Request): Promise<NextResponse> {
  const password = process.env.APP_PASSWORD;
  const token = process.env.APP_SESSION_TOKEN;
  if (!password || !token) {
    return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
  }
  let body: { password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.password !== "string" || body.password !== password) {
    return NextResponse.json({ error: "wrong_password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90, // 90 days — drivers/office shouldn't re-auth often
  });
  return res;
}

export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
