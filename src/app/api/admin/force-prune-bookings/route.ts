// Arm the one-shot "Force-archive deleted Goodshuffle projects" override. This does NOT call Goodshuffle
// (the server is Cloudflare-blocked) and does NOT archive anything itself: it only sets a settings-backed
// flag that the NEXT COMPLETE bookings pull (POST /api/gs/projects, run by the office browser extension)
// consumes to archive every orphan beyond the normal cap, then disarms. See src/lib/ingest/forcePruneBookings.
//
// Auth posture mirrors POST /api/settings exactly: gated by the ADMIN_PIN env via the `x-admin-pin` header.
// When ADMIN_PIN is unset the check is a no-op (null = not configured) — the /admin surface is already
// gated by the role-based access matrix (proxy), same as the settings write. No secrets are touched.

import { NextResponse } from "next/server";
import { armBookingsForcePrune } from "@/lib/ingest/forcePruneBookings";

export const dynamic = "force-dynamic";

function adminPin(): string | null {
  return process.env.ADMIN_PIN || null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const pin = adminPin();
  if (pin && (req.headers.get("x-admin-pin") || "") !== pin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  armBookingsForcePrune();
  return NextResponse.json({ armed: true });
}
