// Shift Pass gateway. A contractor opens /pass/<token> (the link we handed / texted them). We check
// the pass is live, then mint a scoped, self-expiring "guest" session cookie and drop them on the
// dispatch board. No login, no password. Invalid / expired / revoked → the friendly ended page.
//
// Public (listed in proxy PUBLIC) because the visitor has no session yet — the token IS the credential.

import { NextResponse, type NextRequest } from "next/server";
import { getShiftPass, touchShiftPass } from "@/lib/db/repo";
import { isPassLive, passSession } from "@/lib/auth/pass";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { publicOrigin } from "@/lib/http/origin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await ctx.params;
  const origin = publicOrigin(req);

  const secret = process.env.APP_SESSION_TOKEN;
  // Gate disabled → the whole app is open anyway; a pass link just lands on the board.
  if (!secret) return NextResponse.redirect(`${origin}/dispatch`);

  const pass = getShiftPass(token);
  if (!isPassLive(pass)) return NextResponse.redirect(`${origin}/pass-expired`);

  const cookie = await signSession(passSession(pass), secret);
  const maxAge = Math.max(60, Math.floor((Date.parse(pass.expiresAt) - Date.now()) / 1000));
  touchShiftPass(pass.id);

  // Drivers land on the plain route checklist (/route), NOT the office kiosk (/kiosk launches Goodshuffle
  // Pro side-by-side, which a temp driver can't sign into). `pass=1` tells /select to send them to
  // /route after binding — pre-assigned trucks (?truck=) auto-bind and skip the picker. A "board" pass
  // opens the office dispatch board.
  let dest: string;
  if (pass.scope === "board") {
    dest = "/dispatch";
  } else {
    const q = new URLSearchParams({ pass: "1" });
    if (pass.truckId) q.set("truck", pass.truckId);
    dest = `/select?${q.toString()}`;
  }
  const res = NextResponse.redirect(`${origin}${dest}`);
  res.cookies.set(SESSION_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge });
  return res;
}
