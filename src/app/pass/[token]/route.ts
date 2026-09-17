// Shift Pass gateway. A contractor opens /pass/<token> (the link we handed / texted them). We check
// the pass is live, then mint a scoped, self-expiring "guest" session cookie and drop them on the
// dispatch board. No login, no password. Invalid / expired / revoked → the friendly ended page.
//
// Public (listed in proxy PUBLIC) because the visitor has no session yet — the token IS the credential.

import { NextResponse, type NextRequest } from "next/server";
import { getShiftPass, touchShiftPass } from "@/lib/db/repo";
import { isPassLive, passSession } from "@/lib/auth/pass";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await ctx.params;
  const origin = req.nextUrl.origin;

  const secret = process.env.APP_SESSION_TOKEN;
  // Gate disabled → the whole app is open anyway; a pass link just lands on the board.
  if (!secret) return NextResponse.redirect(`${origin}/dispatch`);

  const pass = getShiftPass(token);
  if (!isPassLive(pass)) return NextResponse.redirect(`${origin}/pass-expired`);

  const cookie = await signSession(passSession(pass), secret);
  const maxAge = Math.max(60, Math.floor((Date.parse(pass.expiresAt) - Date.now()) / 1000));
  touchShiftPass(pass.id);

  const res = NextResponse.redirect(`${origin}/dispatch`);
  res.cookies.set(SESSION_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge });
  return res;
}
