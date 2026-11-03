// Sync the marketing lead log from Slack #new-leads now (the runtime clock also runs it every tick).
// Any staff member who can open Marketing may trigger it: it only reads Slack and saves lead posts.

import { NextResponse } from "next/server";
import { syncLeadLogFromSlack, LEAD_LOG_JOB_KEY } from "@/lib/marketing/leadLog";
import { logImport } from "@/lib/pull/state";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const r = await syncLeadLogFromSlack();
  logImport(LEAD_LOG_JOB_KEY, r.ok, { rowsIn: r.scanned, rowsWritten: r.added, detail: r.detail });
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
