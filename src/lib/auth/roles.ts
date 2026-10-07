// Access matrix — Owner / Admin / Member. Pure permission rules (no DB, no crypto) so both the
// proxy (Edge) and server components can import them. RULES, not vibes: every gate traces here.
//
//  - Member: day-to-day ops only. No money, no settings, no user management.
//  - Admin:  everything Member + all financials + settings + manage Members. NOT Admins/Owners.
//  - Owner:  everything, including managing every user (Members, Admins, Owners).

//  - Guest:  a Shift Pass holder (temporary/contractor). NOT a human account — minted only by the
//    /pass/<token> gateway, never assignable in Team management. Scoped hard in the proxy to the
//    dispatch board + driver surface; no money, no settings, no supervisor board writes.
export type Role = "owner" | "admin" | "member" | "guest";

// The human, assignable roles (Team management + role pickers iterate this — guest is NOT here).
export const ROLES: Role[] = ["owner", "admin", "member"];
// Every role a signed session may legitimately carry (guest included — the pass gateway mints it).
const ALL_ROLES: Role[] = [...ROLES, "guest"];

export function isRole(x: unknown): x is Role {
  return typeof x === "string" && (ALL_ROLES as string[]).includes(x);
}

/** A temporary Shift Pass holder — not a real user account. */
export function isGuest(role: Role): boolean {
  return role === "guest";
}

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", guest: "Shift Pass" };

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

/** Can `actor` create/modify/deactivate a user whose role is `target`?
 *  Owner manages everyone; Admin manages Members only; nobody escalates above themselves. */
export function canManageRole(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target === "member";
  return false;
}

/** Which roles `actor` is allowed to assign (for the role dropdown). */
export function assignableRoles(actor: Role): Role[] {
  if (actor === "owner") return ["owner", "admin", "member"];
  if (actor === "admin") return ["member"];
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
