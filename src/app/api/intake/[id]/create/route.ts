// Create the Goodshuffle project SHELL from a completed intake. The server can't call Goodshuffle, so it
// VALIDATES the required fields, then QUEUES a `create_project` op; the logged-in office session drains it
// (creates the project, stashes the structured intake as internal notes) and posts the new id back via
// /api/gs/intake-result. We never claim success here — the success screen flips to "Created" only when
// Goodshuffle actually returns the id. No inventory, no pricing.

import { NextResponse } from "next/server";
import { getIntake, updateIntake } from "@/lib/intake/store";
import { missingRequired } from "@/lib/intake/types";
import { formatIntakeNotes, suggestEventName, gsEventDetails, gsIntakeLocation } from "@/lib/intake/format";
import { autoAddSimpleItems, autoAddLogisticsLegs, windowUpgradeGroup } from "@/lib/intake/gsItems";
import { geocodeAddress } from "@/lib/intake/geocode";
import { logIntakeEvent } from "@/lib/intake/audit";
import { enqueueGsOp } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const intake = getIntake(id);
  if (!intake) return NextResponse.json({ error: "not found" }, { status: 404 });

  const missing = missingRequired(intake);
  if (missing.length > 0) return NextResponse.json({ error: "missing_required", missing }, { status: 400 });

  if (intake.gsProjectId) {
    // Already created — return the existing shell rather than making a duplicate.
    return NextResponse.json({ ok: true, status: "created", gsProjectId: intake.gsProjectId, gsProjectUrl: intake.gsProjectUrl });
  }

  // Geocode the captured delivery address so the office session can set the delivery location and auto-add
  // the location-dependent logistics items (base delivery + Event Readiness). Best-effort: if this returns
  // null, we simply omit the location and those legs — the shell is still created and they're added by hand.
  const geo = await geocodeAddress(intake.streetAddress, intake.city, intake.state, intake.zip);
  const location = gsIntakeLocation(intake, geo);
  const logisticsLegs = location ? autoAddLogisticsLegs(intake) : [];

  // Queue the create for the logged-in office session. eventName is stashed in the notes header until the
  // Goodshuffle rename endpoint is wired.
  enqueueGsOp({ op: "create_project", label: `guided intake ${suggestEventName(intake)}`, payload: { intakeId: intake.id, eventName: suggestEventName(intake), notes: formatIntakeNotes(intake), details: gsEventDetails(intake), addItems: autoAddSimpleItems(), windowUpgrade: windowUpgradeGroup(intake), location, logisticsLegs } });
  updateIntake(id, { status: "creating", gsStatus: "queued" });
  await logIntakeEvent("GS_SHELL_QUEUED", id, { name: suggestEventName(intake) });

  return NextResponse.json({ ok: true, status: "queued" });
}
