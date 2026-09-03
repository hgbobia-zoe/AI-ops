// Access-matrix gate (Next 16 "proxy", formerly middleware). Enforces authentication + coarse
// role gates on every request. INACTIVE until APP_SESSION_TOKEN (the session signing secret) is
// set — fails open so provisioning can't brick the app.
//
//  - any valid session → app access
//  - Financial routes (/finance, /api/finance) → Owner/Admin only (Members blocked)
//  - Settings + user management (/admin, /api/settings, /api/integrations, /api/auth/users)
//    → Owner/Admin only (Members blocked)
// Fine-grained checks (which roles an Admin may manage; per-field $ redaction) live in the
// handlers/pages. Ingest/outbox endpoints enforce their own GS_INGEST_TOKEN (cross-origin).

import { NextResponse, type NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth/session";
import { canSeeFinancials, canManageSettings } from "@/lib/auth/roles";

const PUBLIC: string[] = [
  "/login",
  "/api/auth",
  "/track",
  "/api/kiosk/publish",
  "/api/finance/revenue", // own token; hit by the pull, not a person
  "/api/route/import",
  "/api/gs/projects",
  "/api/gs/outbox",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

const isFinancial = (p: string): boolean => p === "/finance" || p.startsWith("/finance/") || p.startsWith("/api/finance");
const isSettings = (p: string): boolean =>
  p === "/admin" || p.startsWith("/admin/") || p.startsWith("/api/settings") || p.startsWith("/api/integrations") || p.startsWith("/api/auth/users");

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.APP_SESSION_TOKEN;
  if (!secret) return NextResponse.next(); // gate disabled until provisioned

  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (pathname.startsWith("/api/pod") && req.method === "GET") return NextResponse.next(); // public tracking images

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret);
  if (!session) return deny(req, "auth");

  if (isFinancial(pathname) && !canSeeFinancials(session.role)) return deny(req, "forbidden");
  if (isSettings(pathname) && !canManageSettings(session.role)) return deny(req, "forbidden");

  return NextResponse.next();
}

function deny(req: NextRequest, reason: "auth" | "forbidden"): NextResponse {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: reason === "auth" ? "unauthorized" : "forbidden" }, { status: reason === "auth" ? 401 : 403 });
  }
  const url = req.nextUrl.clone();
  if (reason === "auth") {
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
  } else {
    url.pathname = "/"; // not permitted → home
    url.searchParams.set("denied", "1");
  }
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|woff2?)$).*)"],
};
