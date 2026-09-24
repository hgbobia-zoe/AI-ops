// Observable integration health for the Communications blade — Quo CONNECTED (with its real last-event
// time), Sona NOT_CONNECTED, Context API AVAILABLE, webhook BUILT. Honest states only.

import { NextResponse } from "next/server";
import { getCommsHealth } from "@/lib/comms/health";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({ integrations: getCommsHealth() });
}
