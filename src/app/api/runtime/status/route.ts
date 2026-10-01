// Cloud runtime status — the read model for the /admin "Cloud runtime" card. Returns each job's bucket +
// current state (from credentials + the import ledger). Owner/admin; session-gated (not public).

import { NextResponse } from "next/server";
import { runtimeStatus } from "@/lib/runtime/jobs";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ jobs: runtimeStatus() });
}
