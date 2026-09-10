// Invite management — Owner/Admin only (mirrors /api/auth/users' self-gating). An Admin may only invite
// Members; an Owner may invite Admins or Members. Owners are never invited (promote an existing account).
// POST creates an invite (returns the token → link); GET lists pending; DELETE revokes.

import { NextResponse } from "next/server";
import { viewerRole, getSession, viewerInitials } from "@/lib/auth/getSession";
import { canManageUsers, canManageRole, isRole } from "@/lib/auth/roles";
import { getUser } from "@/lib/auth/users";
import { createInvite, listPendingInvites, revokeInvite } from "@/lib/auth/invites";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ invites: listPendingInvites() });
}

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { role?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const newRole = body.role;
  if (!isRole(newRole) || newRole === "owner") return NextResponse.json({ error: "invite role must be admin or member" }, { status: 400 });
  if (!canManageRole(role, newRole)) return NextResponse.json({ error: "cannot invite that role" }, { status: 403 });

  const session = await getSession();
  const creator = session?.uid ? getUser(session.uid) : null;
  const invite = createInvite({
    role: newRole,
    name: body.name,
    invitedBy: session?.uid,
    invitedByName: creator?.name || creator?.username || (await viewerInitials()) || undefined,
  });
  return NextResponse.json({ ok: true, invite });
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: { token?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.token) return NextResponse.json({ error: "token required" }, { status: 400 });
  const removed = revokeInvite(body.token);
  return NextResponse.json({ ok: removed });
}
