// Export due email steps as a CSV, for manual sending or a tool other than Smartlead. Skips the
// do-not-contact list, contacts Sales OS owns, and leads already handed to Smartlead. Smartlead itself is
// fed by the approved push (/api/prospecting/push), never from here. Gated to settings managers.

import { NextResponse } from "next/server";
import { exportEmailTasks } from "@/lib/prospecting/service";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const result = await exportEmailTasks();
  return NextResponse.json({ ok: true, ...result });
}
