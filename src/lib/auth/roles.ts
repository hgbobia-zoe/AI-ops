// Access matrix — Owner / Admin / Member. Pure permission rules (no DB, no crypto) so both the
// proxy (Edge) and server components can import them. RULES, not vibes: every gate traces here.
//
//  - Member: day-to-day ops only. No money, no settings, no user management.
//  - Admin:  everything Member + all financials + settings + manage Members. NOT Admins/Owners.
//  - Owner:  everything, including managing every user (Members, Admins, Owners).

//  - Guest:  a Shift Pass holder (temporary/contractor). NOT a human account — minted only by the
//    /pass/<token> gateway, never assignable in Team management. Scoped hard in the proxy to the
//    dispatch board + driver surface; no money, no settings, no supervisor board writes.
//  - Marketing: a SCOPED, human-assignable staff role for the demand-gen team. Deny-by-default: it may reach
//    its whole demand-generation surface — the Marketing blade incl. Creative Engine (/marketing, /creative),
//    Opportunity Radar (/radar), SEO Growth (/seo), and Website Studio (/website-studio) and their APIs —
//    EXCEPT the Capability Profile (/radar/capability) and Visual DNA (/creative/dna), which stay owner/admin
//    (see MARKETING_DENY_PREFIXES). NOT money, settings, dispatch, scheduling, risk, payroll, user
//    management, AI approvals/ops, coaching, events, etc. (every money/settings capability is FALSE for it
//    below). Its whole surface is financial-data-free. The proxy is the hard boundary.
export type Role = "owner" | "admin" | "member" | "marketing" | "guest";

// The human, assignable roles (Team management + role pickers iterate this — guest is NOT here).
export const ROLES: Role[] = ["owner", "admin", "member", "marketing"];
// Every role a signed session may legitimately carry (guest included — the pass gateway mints it).
const ALL_ROLES: Role[] = [...ROLES, "guest"];

export function isRole(x: unknown): x is Role {
  return typeof x === "string" && (ALL_ROLES as string[]).includes(x);
}

/** A temporary Shift Pass holder — not a real user account. */
export function isGuest(role: Role): boolean {
  return role === "guest";
}

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", marketing: "Marketing", guest: "Shift Pass" };

/** Can this role see revenue / cost / any dollar figure (Financial blade + $ across all blades)? */
export function canSeeFinancials(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Coaching blade — sales-call transcripts + recaps are sensitive, so owner/admin only. */
export function canSeeCoaching(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** App settings, providers/integrations, pulling routes. */
export function canManageSettings(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Can open the team/user-management screen at all. */
export function canManageUsers(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** HR / Payroll — worker pay, hours, and the Gusto sync are sensitive money + PII, so owner/admin only
 *  (same bar as financials/settings). Members never see payroll. */
export function canManagePayroll(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Marketing blade (/marketing) — demand-gen command center: campaigns, content, reviews, outreach. Open
 *  to the back-office staff that runs it (owner/admin/member) AND the scoped marketing role. NOT a guest.
 *  This is the Marketing-role's primary allowed surface; its hard scoping lives in the proxy (deny-by-default).*/
export function canSeeMarketing(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "member" || role === "marketing";
}

/** Console PAGE path prefixes the scoped marketing role may reach — its whole demand-generation surface: the
 *  Marketing blade (incl. Creative Engine, `/creative`), Opportunity Radar (`/radar`), SEO Growth (`/seo`),
 *  and Website Studio (`/website-studio`). Single source of truth shared by the proxy (deny-by-default:
 *  anything else is blocked) and the nav (shows only matching blades). API allow-listing lives in the proxy's
 *  MARKETING_ALLOW, which builds on these. None of these surfaces carries financial data. */
export const MARKETING_PAGE_PREFIXES = ["/marketing", "/creative", "/radar", "/seo", "/website-studio"] as const;
/** Carve-outs INSIDE an allowed prefix that the marketing role must NOT reach — kept owner/admin: the
 *  Capability Profile (`/radar/capability`, a bid/settings-class surface) and Visual DNA (`/creative/dna` +
 *  its write `/api/creative/visual-dna`, the brand identity). Listed here so the proxy and the nav agree.
 *  (The Capability Profile write `/api/pursuit` is simply not in the proxy's MARKETING_ALLOW, so it's denied
 *  by default without needing a carve-out.) */
export const MARKETING_DENY_PREFIXES = ["/radar/capability", "/creative/dna", "/api/creative/visual-dna"] as const;
/** True when `pathname` is a marketing carve-out (blocked even though it sits under an allowed prefix). Pure. */
export function marketingDenied(pathname: string): boolean {
  return MARKETING_DENY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
/** True when `pathname` is on the marketing role's allowed PAGE surface (exact or a sub-path) and not a
 *  carve-out. Pure. */
export function marketingCanReachPage(pathname: string): boolean {
  if (marketingDenied(pathname)) return false;
  return MARKETING_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/** Website Studio — prompt a website code change and get back a PR (nothing goes live without a human merge).
 *  The marketing team drives it, so this is the one back-office capability a Member may hold too (unlike
 *  settings/financials). It only ever QUEUES a request; the office runner opens a PR a human reviews. We keep
 *  it to staff accounts (owner/admin/member) + the scoped marketing role — never a guest/Shift Pass holder.
 *  The marketing role is confined to THIS + the Marketing blade by the proxy (deny-by-default). */
export function canUseWebsiteStudio(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "member" || role === "marketing";
}

/** SEO Growth — the organic-demand engine (keyword research, opportunity matching, competitor intel, content
 *  production + publishing). The marketing team runs it, so it's open to owner/admin AND the scoped marketing
 *  role — but NOT Members (it stayed owner/admin before this). It carries no financial data. The SEO
 *  integration CREDENTIAL stays settings-gated (owner/admin), so marketing operates the tool without the
 *  secret. Distinct from canManageSettings on purpose. */
export function canUseSeo(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "marketing";
}

/** Can `actor` create/modify/deactivate a user whose role is `target`?
 *  Owner manages everyone; Admin manages Members + the scoped Marketing role (both below Admin); nobody
 *  escalates above themselves. Guest is never a managed/assignable account (minted by the pass gateway). */
export function canManageRole(actor: Role, target: Role): boolean {
  if (target === "guest") return false; // Shift Pass holders aren't managed in Team
  if (actor === "owner") return true;
  if (actor === "admin") return target === "member" || target === "marketing";
  return false;
}

/** Which roles `actor` is allowed to assign (for the role dropdown). */
export function assignableRoles(actor: Role): Role[] {
  if (actor === "owner") return ["owner", "admin", "member", "marketing"];
  if (actor === "admin") return ["member", "marketing"];
  return [];
}

// ── AI Control Plane capabilities ──────────────────────────────────────────────
// The design names four conceptual levels (VIEWER / OPERATOR / MANAGER / ADMIN). This repo has three
// staff roles plus guest, so they map on cleanly: VIEWER+OPERATOR → any staff (member+), MANAGER+ADMIN →
// owner/admin. The AI NEVER holds a permission a human doesn't: these gates are checked the same way the
// app gates everything else, and an AI-proposed action still passes through the SAME approval + outbox +
// send-gate path a human would. A guest (Shift Pass) has NO AI access.
export type AiCapabilityLevel = "none" | "viewer" | "operator" | "manager" | "admin";

/** See AI sessions, the command center and per-blade AI activity (read-only). Any signed staff. */
export function canViewAi(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

/** Start AI sessions and let agents run their READ/ANALYZE/DRAFT tools (no external effect). Staff. */
export function canOperateAi(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

/** Decide an AI-proposed action (approve / reject / edit). Governance over anything that can reach the
 *  outbox, so owner/admin — the same bar as settings. Financial cards still honor canSeeFinancials. */
export function canApproveAi(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Configure the plane: choose the AI provider, connect the session bridge, toggle per-blade AI. Owner/
 *  admin (settings-level). */
export function canManageAi(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** The highest AI capability level a role holds (drives UI labels; never a security boundary on its own —
 *  the predicates above are). */
export function aiCapabilityLevel(role: Role): AiCapabilityLevel {
  if (canManageAi(role)) return "admin";
  if (canApproveAi(role)) return "manager";
  if (canOperateAi(role)) return "operator";
  if (canViewAi(role)) return "viewer";
  return "none";
}
