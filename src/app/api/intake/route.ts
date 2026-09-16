// Start a new guided sales intake — creates a draft record attributed to the signed-in rep. The wizard
// then autosaves answers via PATCH /api/intake/[id]. Proxy-gated to console users.

import { NextResponse } from "next/server";
import { createIntake } from "@/lib/intake/store";
import { logIntakeEvent } from "@/lib/intake/audit";
import { currentActor } from "@/lib/auth/getSession";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const actor = await currentActor();
  const intake = createIntake({ createdBy: actor.label, source: "manual" });
  await logIntakeEvent("INTAKE_STARTED", intake.id);
  return NextResponse.json({ intake });
}
