// Verify Connecteam write access for People provisioning. Owner/admin only. Runs the real probe (creates
// nobody) and sets or clears the verified record from the result; there is no way to set it by hand.

import { NextResponse } from "next/server";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageUsers } from "@/lib/auth/roles";
import { verifyConnecteamScope } from "@/lib/people/connecteamScope";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageUsers(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = (await currentActor()).label;
  const r = await verifyConnecteamScope(actor);
  const message = r.ok
    ? `Verified. Connecteam steps now run from People${r.tasksUpdated ? ` (${r.tasksUpdated} open step${r.tasksUpdated === 1 ? "" : "s"} switched)` : ""}.`
    : `Not verified: ${r.detail}.`;
  return NextResponse.json({ ok: r.ok, message }, { status: r.ok ? 200 : 409 });
}
