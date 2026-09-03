// Run an Event Risk scan on demand (also called on /risk load). Server-side; reads our DB +
// Connecteam. Safe/read-mostly: it only writes to risk_items / event_readiness and may Slack
// meaningful changes — it never touches dispatch routes, Goodshuffle, the outbox, or SMS.

import { NextResponse } from "next/server";
import { runScan } from "@/lib/risk/scan";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  let horizonDays: number | undefined;
  try {
    horizonDays = ((await req.json().catch(() => ({}))) as { horizonDays?: number })?.horizonDays;
  } catch {
    /* ignore */
  }
  const result = await runScan({ horizonDays, force: true });
  return NextResponse.json({
    ok: true,
    dates: result.dates,
    findings: result.findings,
    queueSize: result.queueSize,
    connecteam: result.connecteam,
    changed: {
      created: result.changes.created.length,
      escalated: result.changes.escalated.length,
      resolved: result.changes.resolved.length,
      regressed: result.changes.regressed.length,
    },
  });
}
