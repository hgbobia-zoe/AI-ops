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
import { canSeeFinancials, canManageSettings, canSeeCoaching, canManagePayroll } from "@/lib/auth/roles";
import { verifyImageSig } from "@/lib/creative/assetUrl";

const PUBLIC: string[] = [
  "/login",
  "/join", // invite acceptance — the invitee isn't logged in yet (token-gated by the invite itself)
  "/pass", // Shift Pass gateway — the visitor has no session yet; the token IS the credential
  "/pass-expired", // dead-end for an ended/invalid pass (no session)
  "/api/auth",
  "/track",
  // Live truck position + ETA by truckId+stopId. Driver tablets (device-bound, no session), shift-pass
  // guest links, and the customer /track page all need this with no login. Low sensitivity: it returns the
  // same live-GPS data already texted to customers as a tracking link, and never writes. NOTE: the admin
  // fleet-discovery sub-path /api/eta/units is EXCLUDED from this (it lists every vehicle id) and is gated
  // to owner/admin in proxy() below — adding /api/eta here does NOT make /api/eta/units public.
  "/api/eta",
  // Driver tablets are bound to a TRUCK, not a person (device binding, no login), so the whole
  // driver surface must stay open when per-person auth is enabled — otherwise the field is locked out.
  "/kiosk",
  "/select",
  "/route",
  "/api/action", // driver ARRIVED / COMPLETED / HEADING_NEXT taps
  "/api/pod", // driver photo/signature upload + public tracking images (ids are unguessable capabilities)
  "/api/kiosk", // kiosk publish + OTA (latest/download)
  "/api/vehicles", // driver truck-picker (/select) reads the truck list; GET-only, not sensitive
  "/api/finance/revenue", // own token; hit by the pull, not a person
  "/api/route/import",
  "/api/instawork/import", // Auto-Pull Instawork browser pull POST (from a logged-in app.instawork.com tab); own token (fail-open), CORS-locked to app.instawork.com — must not bounce to auth
  "/api/payroll/gusto/import", // Auto-Pull Gusto browser pull POST (from a logged-in app.gusto.com tab); GS_INGEST_TOKEN (fail-open), CORS-locked to app.gusto.com — must not bounce to auth (and NOT be caught by the owner/admin /api/payroll gate)

  "/api/route/prune", // Auto-Pull sanitize: drop routes GS no longer has; own token (fail-open), CORS-locked
  "/api/gs/projects",
  "/api/gs/notes",
  "/api/gs/emails", // Auto-Pull captures the client email thread; own token (fail-open), CORS-locked — must not bounce to auth
  "/api/gs/outbox",
  "/api/gs/intake-result", // Auto-Pull reports the created project id back here; own token (fail-open), CORS-locked — must not bounce to auth
  "/api/etalink", // Ignition etaLink mint pending/result; GS_INGEST_TOKEN (fail-open), CORS-locked to ignition.zonarsystems.com — the office-machine Ignition tab reads/posts here, NOT a session (distinct from the /api/eta GPS prefix)
  "/api/pull/heartbeat", // Auto-Pull extension status ping; own token (fail-open), CORS-open
  "/api/runtime/tick", // Cloud runtime heartbeat; RUNTIME_TOKEN-gated (503 until set), hit by GitHub Actions (not a session)
  "/api/openphone/webhook", // OpenPhone → us; authenticates by HMAC signature, not a session
  "/api/communications/events", // Comms adapter ingress (Quo/Sona → us); COMMS_INGEST_TOKEN (fail-open), CORS-locked — NOT a session. Only this exact path is public; the rest of /api/communications stays session-gated.
  "/api/creative/callback", // n8n → us; authenticates by a per-generation callback token, not a session
  "/api/coach", // Custodian live-coach bridge; authenticates by COACH_API_TOKEN bearer, not a session
  "/api/radar/ingest", // Opportunity Radar browser-agent POST; RADAR_INGEST_TOKEN + CORS-locked, not a session
  "/api/radar/cron", // Opportunity Radar scheduled source pull; RADAR_INGEST_TOKEN, hit by an external scheduler
  "/api/seo/cron", // SEO Growth scheduled discovery pull; SEO_INGEST_TOKEN, hit by an external scheduler (not a session)
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

const isFinancial = (p: string): boolean => p === "/finance" || p.startsWith("/finance/") || p.startsWith("/api/finance");
const isSettings = (p: string): boolean =>
  p === "/admin" ||
  p.startsWith("/admin/") ||
  p.startsWith("/api/settings") ||
  p.startsWith("/api/integrations") ||
  p.startsWith("/api/auth/users") ||
  p.startsWith("/api/passes") || // generating / listing / revoking / texting Shift Passes — owner/admin only
  p.startsWith("/api/pricing/config") || // delivery pricing config editor — owner/admin only (the quote endpoints stay staff-gated)
  p.startsWith("/api/pursuit") || // capability profile + bid pre-staging — owner/admin only
  // AI Control Plane management: choosing the provider, connecting the session bridge, per-blade AI config,
  // and deciding proposed actions are owner/admin only. Viewing + operating sessions (/api/ai/sessions)
  // stays staff-gated (any signed session) — it is NOT under these manage prefixes.
  p.startsWith("/api/ai/config") ||
  p.startsWith("/api/ai/provider") ||
  p.startsWith("/api/ai/bridge") ||
  p.startsWith("/api/ai/approvals"); // deciding an AI-proposed action (governance)

// SEO Growth — keyword research + content pipeline. Settings-ish (it manages an integration + is
// owner/admin-only, mirroring the `manage` nav flag), so it is gated to owner/admin here. Normal
// session-gated console routes — NOT public, NOT token-gated like the ingest endpoints.
const isSeo = (p: string): boolean => p === "/seo" || p.startsWith("/seo/") || p.startsWith("/api/seo");

// A Shift Pass (guest) is scoped HARD to the dispatch board + the (already public) driver surface. It
// is deny-by-default: only these prefixes are reachable, so no money, settings, coaching, sales, or the
// supervisor board writes under /api/route/* are ever exposed to a contractor's link.
const GUEST_ALLOW: string[] = [
  "/dispatch",
  "/track",
  "/kiosk",
  "/select",
  "/route",
  "/api/eta", // live GPS/ETA the board reads
  "/api/dispatch/route-health", // board health strip (read-only)
  "/api/vehicles",
  "/api/action", // driver taps (also public)
  "/api/pod", // driver photo/signature (also public)
  "/api/kiosk",
  "/api/route/stop/complete", // "drive": mark a stop done. NOT remove/reopen/close/driver (supervisor).
];
const guestAllowed = (p: string): boolean => GUEST_ALLOW.some((a) => p === a || p.startsWith(a + "/"));
// Post-call coaching — sensitive transcripts + recaps, owner/admin only.
const isCoaching = (p: string): boolean => p === "/coaching" || p.startsWith("/coaching/") || p.startsWith("/api/coaching");
// HR / Payroll — worker pay, hours, Gusto sync. Sensitive money + PII, owner/admin only (canManagePayroll).
const isPayroll = (p: string): boolean => p === "/payroll" || p.startsWith("/payroll/") || p.startsWith("/api/payroll");

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.APP_SESSION_TOKEN;
  if (!secret) return NextResponse.next(); // gate disabled until provisioned

  const { pathname } = req.nextUrl;
  // /api/eta/units lists the whole fleet's vehicle ids — owner/admin only. It sits under the /api/eta
  // prefix (which is PUBLIC for position/ETA by id), so exclude it from the public match here and let the
  // explicit owner/admin gate below enforce it (deny-by-default, even for shift-pass guests).
  const isEtaUnits = pathname === "/api/eta/units" || pathname.startsWith("/api/eta/units/");
  if (!isEtaUnits && isPublicPath(pathname)) return NextResponse.next();
  if (pathname.startsWith("/api/pod") && req.method === "GET") return NextResponse.next(); // public tracking images
  // Creative source/reference images for the off-box n8n workflow: admit a GET ONLY when it carries a valid,
  // unexpired signature (minted per-image at handoff). No session is needed, but images are NOT public — an
  // unsigned/expired request falls through to the normal session gate below.
  if (pathname.startsWith("/api/creative/image/") && req.method === "GET") {
    const id = decodeURIComponent(pathname.slice("/api/creative/image/".length));
    if (await verifyImageSig(id, req.nextUrl.searchParams.get("exp"), req.nextUrl.searchParams.get("sig"))) {
      return NextResponse.next();
    }
  }
  // Driver truck-picker → kiosk reads its assigned route here. EXACT GET only, so the dispatcher write
  // actions under /api/route/* (close, reopen, driver, stop/remove) stay authenticated.
  if (pathname === "/api/route" && req.method === "GET") return NextResponse.next();

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret);
  if (!session) return deny(req, "auth");

  // Fleet vehicle-id discovery (/api/eta/units) → owner/admin only. Checked before the guest + role
  // branches so a shift-pass guest (whose GUEST_ALLOW includes the /api/eta prefix) can't reach it.
  if (isEtaUnits) return canManageSettings(session.role) ? NextResponse.next() : deny(req, "forbidden");

  // Shift Pass holders are scoped hard, before any staff role gate — deny-by-default outside the board
  // + driver surface. (Revocation is checked server-side in the console layout; expiry is in the cookie.)
  if (session.role === "guest") {
    if (guestAllowed(pathname)) return NextResponse.next();
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.redirect(new URL("/dispatch", req.nextUrl)); // never bounce a guest to "/" (loops)
  }

  if (isFinancial(pathname) && !canSeeFinancials(session.role)) return deny(req, "forbidden");
  if (isSettings(pathname) && !canManageSettings(session.role)) return deny(req, "forbidden");
  if (isSeo(pathname) && !canManageSettings(session.role)) return deny(req, "forbidden");
  if (isCoaching(pathname) && !canSeeCoaching(session.role)) return deny(req, "forbidden");
  if (isPayroll(pathname) && !canManagePayroll(session.role)) return deny(req, "forbidden");

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
