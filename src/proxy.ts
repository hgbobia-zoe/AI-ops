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
import { canSeeFinancials, canManageSettings, canSeeCoaching, canManagePayroll, canManageUsers, canUseWebsiteStudio, canUseSeo, canSeeMarketing, marketingDenied, MARKETING_PAGE_PREFIXES } from "@/lib/auth/roles";
import { verifyImageSig } from "@/lib/creative/assetUrl";

const PUBLIC: string[] = [
  "/login",
  "/privacy", // public privacy policy (Chrome Web Store listing requirement for the Auto-Pull extension)
  "/api/version", // build identity (git commit / deploy time) — no secrets; read by the improvement controller + monitoring
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
  "/api/payroll/gusto/push-result", // Auto-Pull Gusto hours-PUSH outcome POST (from the logged-in app.gusto.com tab after the DRAFT write); GS_INGEST_TOKEN (fail-open), CORS-locked to app.gusto.com — same gate as import; NOTE the push-PAYLOAD builder (/api/payroll/gusto/push-payload) is NOT here — it stays session + owner/admin gated
  "/api/payroll/gusto/runner", // Gusto remote-browser office-runner endpoints (next/job/update/artifact); GUSTO_RUNNER_TOKEN-gated in-handler, fail-CLOSED (503 until set) — the office machine's Playwright runner hits these, NOT a session (and must NOT be caught by the owner/admin /api/payroll gate). The /console sub-path is NOT here — it stays session + owner/admin gated.

  "/api/route/prune", // Auto-Pull sanitize: drop routes GS no longer has; own token (fail-open), CORS-locked
  "/api/gs/projects",
  "/api/gs/notes",
  "/api/gs/emails", // Auto-Pull captures the client email thread; own token (fail-open), CORS-locked — must not bounce to auth
  "/api/gs/outbox",
  "/api/gs/intake-result", // Auto-Pull reports the created project id back here; own token (fail-open), CORS-locked — must not bounce to auth
  "/api/intake/lead", // Structured lead receiver — every source Zap POSTs here with no session; INTAKE_TOKEN (fail-open-until-set) is the gate. EXACT path only: the /api/intake wizard + /api/intake/[id]/create stay session-gated.
  "/api/payroll/wire-detected", // Mercury "wire out to Gusto" webhook — a Zapier workflow POSTs the matching transaction with no session; WIRE_WEBHOOK_TOKEN (fail-open-until-set) is the gate. EXACT path only, so it is NOT caught by the owner/admin /api/payroll gate; the rest of /api/payroll stays session + owner/admin gated.
  "/api/etalink", // Ignition etaLink mint pending/result; GS_INGEST_TOKEN (fail-open), CORS-locked to ignition.zonarsystems.com — the office-machine Ignition tab reads/posts here, NOT a session (distinct from the /api/eta GPS prefix)
  "/api/pull/heartbeat", // Auto-Pull extension status ping; own token (fail-open), CORS-open
  "/api/runtime/tick", // Cloud runtime heartbeat; RUNTIME_TOKEN-gated (503 until set), hit by GitHub Actions (not a session)
  "/api/ai/announce-test", // Slack announce self-test; RUNTIME_TOKEN-gated OR internal localhost only; posts a harmless test card (not a session)
  "/api/openphone/webhook", // OpenPhone → us; authenticates by HMAC signature, not a session
  "/api/slack/events", // Viktor (Slack bot) inbound; authenticates by Slack's HMAC signature, not a session
  "/api/slack/interactivity", // Slack Block Kit button clicks (Approve/Dismiss); HMAC-signed + approver-gated, not a session
  "/api/communications/events", // Comms adapter ingress (Quo/Sona → us); COMMS_INGEST_TOKEN (fail-open), CORS-locked — NOT a session. Only this exact path is public; the rest of /api/communications stays session-gated.
  "/api/creative/callback", // n8n → us; authenticates by a per-generation callback token, not a session
  "/api/coach", // Custodian live-coach bridge; authenticates by COACH_API_TOKEN bearer, not a session
  "/api/radar/ingest", // Opportunity Radar browser-agent POST; RADAR_INGEST_TOKEN + CORS-locked, not a session
  "/api/radar/cron", // Opportunity Radar scheduled source pull; RADAR_INGEST_TOKEN, hit by an external scheduler
  "/api/seo/cron", // SEO Growth scheduled discovery pull; SEO_INGEST_TOKEN, hit by an external scheduler (not a session)
  "/api/seo/ingest", // SEO Growth office-runner PUSH (Ubersuggest MCP is OAuth-only, so the office machine pulls + posts here); SEO_INGEST_TOKEN (fail-open), CORS-locked — not a session
  "/api/website/runner", // Website Studio office-runner endpoints (next/update); WEBSITE_RUNNER_TOKEN-gated in-handler, fail-CLOSED (503 until set) — the office machine hits these, NOT a session. Only the /runner sub-path is public; /api/website/jobs stays session + role-gated below.
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
  p.startsWith("/api/slack/users") || // Slack workspace directory for the /admin approver picker — owner/admin only
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

// SEO Growth — keyword research + content pipeline. Owner/admin AND the scoped marketing role run it
// (canUseSeo); Members do not. The SEO integration CREDENTIAL stays settings-gated (owner/admin) so marketing
// operates the tool without the secret. Normal session-gated console routes — NOT public, NOT token-gated
// like the ingest endpoints. (The marketing role is admitted by its own deny-by-default branch above.)
const isSeo = (p: string): boolean => p === "/seo" || p.startsWith("/seo/") || p.startsWith("/api/seo");

// Inventory Automation — bulk-copy a partner's Goodshuffle catalog into Zoe's. It manages inventory
// writes + partner config, so owner/admin only (canManageSettings), mirroring the `manage` nav flag.
const isInventory = (p: string): boolean => p === "/inventory" || p.startsWith("/inventory/") || p.startsWith("/api/inventory");

// Website Studio — the marketing team's prompt→PR queue for the SEPARATE website repo. Any staff
// (canUseWebsiteStudio: owner/admin/member, never guest) may submit + list jobs. The office-runner endpoints
// (/api/website/runner/*) are token-gated and already PUBLIC above, so this gate covers only the blade + the
// submit/list API. It only QUEUES a request; nothing goes live without a human merging the resulting PR.
const isWebsiteStudio = (p: string): boolean =>
  p === "/website-studio" || p.startsWith("/website-studio/") || p === "/api/website/jobs" || p.startsWith("/api/website/jobs/");

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

// A Marketing (scoped) staff user is confined HARD — deny-by-default — to its demand-generation surface: the
// Marketing blade (incl. Creative Engine), Opportunity Radar, SEO Growth, and Website Studio, plus the APIs
// those pages call. Nothing else a Member can see (money, settings, dispatch, scheduling, risk, payroll,
// people, AI, coaching, events…) is reachable: an unlisted path is blocked HERE at the hard boundary, not
// merely hidden in the nav. Shared shell CSS/JS is served from /_next/static (excluded by the matcher) and
// auth/logout is PUBLIC above, so neither needs a slot here. None of these surfaces carries financial data.
// Website Studio only QUEUES a PR request — nothing goes live without a human merging the PR.
const MARKETING_ALLOW: string[] = [
  ...MARKETING_PAGE_PREFIXES, // page surface from roles.ts: /marketing, /creative, /radar, /seo, /website-studio
  "/api/marketing", // Marketing blade data (campaigns/content/reviews/prospects/links)
  "/api/creative", // Creative Engine (jobs/experiments/provider/visual-dna/upload) — under the Marketing blade
  "/api/radar", // Opportunity Radar data (sources/companies/outreach-plan/import)
  "/api/opportunity", // Radar opportunity pipeline (interpret/stage/handoff/campaign/seed)
  // NOTE: /api/pursuit (Capability Profile writes) is deliberately NOT here — Capability Profile stays
  // owner/admin. Visual DNA's page + write are carved out via marketingDenied below.
  "/api/seo", // SEO Growth data (discovery/opportunities/competitors/content/queue/performance)
  "/api/website/jobs", // Website Studio submit/list/decision (also canUseWebsiteStudio-gated below)
];
// Allowed iff it matches a MARKETING_ALLOW prefix AND is not a carve-out (Capability Profile page / Visual DNA).
const marketingAllowed = (p: string): boolean => !marketingDenied(p) && MARKETING_ALLOW.some((a) => p === a || p.startsWith(a + "/"));
// Marketing blade — reachable by back-office staff (owner/admin/member) AND the scoped marketing role; a
// guest never (handled by the earlier guest branch). Explicit gate so a future role without canSeeMarketing
// is denied by default; deny-by-default for the marketing role itself is enforced in its own branch above.
const isMarketing = (p: string): boolean => p === "/marketing" || p.startsWith("/marketing/") || p.startsWith("/api/marketing");
// Post-call coaching — sensitive transcripts + recaps, owner/admin only.
const isCoaching = (p: string): boolean => p === "/coaching" || p.startsWith("/coaching/") || p.startsWith("/api/coaching");
// HR / Payroll — worker pay, hours, Gusto sync. Sensitive money + PII, owner/admin only (canManagePayroll).
const isPayroll = (p: string): boolean => p === "/payroll" || p.startsWith("/payroll/") || p.startsWith("/api/payroll");
// People Lifecycle — onboarding/offboarding + access provisioning. A settings-class capability (it can
// create/disable logins), so owner/admin only (canManageUsers), like /admin/users.
const isPeople = (p: string): boolean => p === "/people" || p.startsWith("/people/") || p.startsWith("/api/people");

// The endpoints a headless responder may reach with a valid x-bridge-token (each validates the token in its
// own handler; the ones that don't accept it still reject it there). PURE. Kept narrow on purpose.
export function isHeadlessTokenPath(pathname: string): boolean {
  return (
    pathname === "/api/ai/bridge" || pathname.startsWith("/api/ai/bridge/") ||
    pathname === "/api/ai/improvement" || pathname.startsWith("/api/ai/improvement/") ||
    // The responder raises an approval CARD here for an operational ask. Self-token-authed exactly like
    // /api/ai/bridge; it only CREATES a pending approval (decide/execute stays human-only via
    // /api/ai/approvals/decide), so admitting a valid-token request widens nothing the governance gate owns.
    pathname === "/api/ai/propose" ||
    // The responder FILES a backlog request here (a feature idea / tracked ask) and records a PR on one via
    // /api/ai/requests/manage. The route is built to accept the x-bridge-token; without this the proxy 401s
    // it before the route runs, so the responder could never file a request. A request is a tracked record,
    // never a production change, so admitting a valid-token request is safe.
    pathname === "/api/ai/requests" || pathname.startsWith("/api/ai/requests/")
  );
}

// Inline token check (constant comparison against AI_BRIDGE_TOKEN) — intentionally NOT imported from the
// provider module so the proxy/middleware stays free of DB/node imports and Edge-safe. Mirrors
// bridgeTokenValid. PURE given the env.
export function bridgeTokenOk(token: string | null | undefined): boolean {
  const expected = process.env.AI_BRIDGE_TOKEN;
  return !!expected && typeof token === "string" && token.length > 0 && token === expected;
}

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

  // Headless responder path. The session-bridge (/api/ai/bridge*) and the self-improvement controller
  // (/api/ai/improvement*) are built to be driven by a headless agent that authenticates with the shared
  // x-bridge-token — exactly like the token-gated ingest endpoints, which validate their own token. Those
  // routes sit under the owner/admin "settings" gate, so a token-only request (no cookie) would be denied
  // here BEFORE the route's own token check ever ran — which is what blocked the responder entirely. Let a
  // request carrying a VALID token through so the route-level check runs. This widens nothing the controller
  // protects: the routes that do NOT accept the token (improvement config + candidates — owner/admin only)
  // still reject it at the handler, so the agent can never change its own budget/autonomy via the token.
  if (isHeadlessTokenPath(pathname) && bridgeTokenOk(req.headers.get("x-bridge-token"))) {
    return NextResponse.next();
  }

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

  // Marketing (scoped staff) is deny-by-default, scoped hard to its demand-generation surface (Marketing +
  // Creative + Opportunity Radar + SEO Growth + Website Studio + their APIs) — before any of the staff role
  // gates below. Anything not on the allow-list is blocked here: an API gets a 403; a page bounces to
  // /marketing (never to "/", which would loop through this same deny).
  if (session.role === "marketing") {
    if (marketingAllowed(pathname)) return NextResponse.next();
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.redirect(new URL("/marketing", req.nextUrl));
  }

  if (isFinancial(pathname) && !canSeeFinancials(session.role)) return deny(req, "forbidden");
  if (isSettings(pathname) && !canManageSettings(session.role)) return deny(req, "forbidden");
  if (isSeo(pathname) && !canUseSeo(session.role)) return deny(req, "forbidden");
  if (isInventory(pathname) && !canManageSettings(session.role)) return deny(req, "forbidden");
  if (isCoaching(pathname) && !canSeeCoaching(session.role)) return deny(req, "forbidden");
  if (isPayroll(pathname) && !canManagePayroll(session.role)) return deny(req, "forbidden");
  if (isPeople(pathname) && !canManageUsers(session.role)) return deny(req, "forbidden");
  if (isWebsiteStudio(pathname) && !canUseWebsiteStudio(session.role)) return deny(req, "forbidden");
  if (isMarketing(pathname) && !canSeeMarketing(session.role)) return deny(req, "forbidden");

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
