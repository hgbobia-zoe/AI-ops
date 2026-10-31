// Quo contact duplicate report (read-only). Pages the whole Quo address book through the public API and
// returns the duplicate groups + counts. Owner/admin only: /api/integrations is under the proxy's settings
// gate. `?refresh=1` skips the 10-minute cache.

import { NextResponse } from "next/server";
import { getQuoDedupeReport, QuoNotConfiguredError } from "@/lib/comms/quoContacts";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  try {
    return NextResponse.json(await getQuoDedupeReport(refresh));
  } catch (e) {
    if (e instanceof QuoNotConfiguredError) {
      return NextResponse.json({ error: "quo_not_configured" }, { status: 503 });
    }
    return NextResponse.json({ error: "quo_error", message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
