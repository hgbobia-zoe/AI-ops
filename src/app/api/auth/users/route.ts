// Team/user management API. Guarded by the access matrix: Owner/Admin only, and an Admin may only
// touch Members (canManageRole). No hard deletes — deactivate instead. No self-lockout / last-owner
// removal.

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { getSession } from "@/lib/auth/getSession";
import { canManageUsers, canManageRole, isRole, type Role } from "@/lib/auth/roles";
import { listUsers, createUser, getUser, setUserRole, setUserActive, setUserPassword, usernameExists } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ users: listUsers(), viewerRole: role });
}

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { username?: string; name?: string; role?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const username = (body.username ?? "").trim();
  const newRole = body.role;
  if (!username || !isRole(newRole) || typeof body.password !== "string") {
    return NextResponse.json({ error: "username, valid role, and password required" }, { status: 400 });
  }
  if (!canManageRole(role, newRole)) return NextResponse.json({ error: "cannot assign that role" }, { status: 403 });
  if (body.password.length < 8) return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  if (usernameExists(username)) return NextResponse.json({ error: "username already exists" }, { status: 409 });

  const user = createUser({ username, name: body.name, role: newRole, password: body.password });
  return NextResponse.json({ ok: true, user });
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const actorRole = await viewerRole();
  const session = await getSession();
  if (!canManageUsers(actorRole)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { id?: string; role?: string; active?: boolean; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const target = body.id ? getUser(body.id) : null;
  if (!target) return NextResponse.json({ error: "user not found" }, { status: 404 });

  // The actor must be allowed to manage the target's CURRENT role (an Admin can't touch an Owner/Admin).
  if (!canManageRole(actorRole, target.role)) return NextResponse.json({ error: "not permitted to manage this user" }, { status: 403 });

  // Role change → must also be allowed to grant the NEW role.
  if (body.role !== undefined) {
    if (!isRole(body.role) || !canManageRole(actorRole, body.role)) {
      return NextResponse.json({ error: "cannot assign that role" }, { status: 403 });
    }
    // Don't demote the last active owner.
    if (target.role === "owner" && body.role !== "owner" && lastActiveOwner(target.id)) {
      return NextResponse.json({ error: "cannot demote the last owner" }, { status: 409 });
    }
    setUserRole(target.id, body.role as Role);
  }

  if (body.active !== undefined) {
    if (!body.active) {
      if (session?.uid === target.id) return NextResponse.json({ error: "cannot deactivate yourself" }, { status: 409 });
      if (target.role === "owner" && lastActiveOwner(target.id)) return NextResponse.json({ error: "cannot deactivate the last owner" }, { status: 409 });
    }
    setUserActive(target.id, body.active);
  }

  if (typeof body.password === "string") {
    if (body.password.length < 8) return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
    setUserPassword(target.id, body.password);
  }

  return NextResponse.json({ ok: true, user: getUser(target.id) });
}

function lastActiveOwner(excludingId: string): boolean {
  return listUsers().filter((u) => u.role === "owner" && u.active && u.id !== excludingId).length === 0;
}
