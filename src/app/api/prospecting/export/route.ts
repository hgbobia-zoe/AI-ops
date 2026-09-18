// Export due Tier-B email steps to the cold-email sequencer: returns a CSV (imports into Instantly /
// Smartlead / Apollo / lemlist) and pushes to the configured provider when one is set. We never send
// from here — the sequencer owns sending, warmup, throttling and unsubscribe on a separate warmed
// domain. Gated to users who can manage settings.

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
