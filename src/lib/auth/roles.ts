// Access matrix — Owner / Admin / Member. Pure permission rules (no DB, no crypto) so both the
// proxy (Edge) and server components can import them. RULES, not vibes: every gate traces here.
//
//  - Member: day-to-day ops only. No money, no settings, no user management.
//  - Admin:  everything Member + all financials + settings + manage Members. NOT Admins/Owners.
//  - Owner:  everything, including managing every user (Members, Admins, Owners).

export type Role = "owner" | "admin" | "member";

export const ROLES: Role[] = ["owner", "admin", "member"];

export function isRole(x: unknown): x is Role {
  return typeof x === "string" && (ROLES as string[]).includes(x);
}

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** Can this role see revenue / cost / any dollar figure (Financial blade + $ across all blades)? */
export function canSeeFinancials(role: Role): boolean {
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
