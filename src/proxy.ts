// Site-wide password gate. Protects every page and API route with the session cookie set at
// /login, EXCEPT public surfaces (customer tracking links, and cross-origin/own-token endpoints
// the bookmarklet + kiosk hit). INACTIVE until APP_PASSWORD + APP_SESSION_TOKEN are set, so it
// can never lock anyone out before it's provisioned.

import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "zoe_session";

// Public — never require the session cookie. The ingest/outbox + token-gated endpoints enforce
// their OWN x-publish-token (they're hit cross-origin by the bookmarklet, which can't send a
// same-origin cookie). Customer tracking + its POD images stay public.
const PUBLIC: string[] = [
  "/login",
  "/api/auth",
  "/track",
  "/api/kiosk/publish",
  "/api/finance/revenue",
  "/api/route/import",
  "/api/gs/projects",
  "/api/gs/outbox",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function proxy(req: NextRequest): NextResponse {
  const password = process.env.APP_PASSWORD;
  const token = process.env.APP_SESSION_TOKEN;
  // Gate disabled until fully configured — fail OPEN so provisioning can't brick the app.
  if (!password || !token) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  // Proof-of-delivery images are shown on public tracking pages — allow GET; uploads (POST) are gated.
  if (pathname.startsWith("/api/pod") && req.method === "GET") return NextResponse.next();

  if (req.cookies.get(SESSION_COOKIE)?.value === token) return NextResponse.next();

  // Not authenticated.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

// Run on everything except Next internals + static assets.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|woff2?)$).*)"],
};
