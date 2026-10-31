// Merge ONE group of duplicate Quo contacts into the most complete one, then delete the rest. Every step
// and safety check lives in mergeQuoContacts (lib/comms/quoContacts.ts): fresh re-fetch, must still be one
// duplicate group, verify before delete, full-JSON audit backup before delete.
//
// Auth: owner/admin via the proxy's settings gate (/api/integrations), plus the ADMIN_PIN header exactly
// like the other integrations writes (a no-op when ADMIN_PIN is unset). The merge is attributed to the
// signed-in user in the audit trail.

import { NextResponse } from "next/server";
import { currentActor } from "@/lib/auth/getSession";
import { mergeQuoContacts, QuoNotConfiguredError } from "@/lib/comms/quoContacts";

export const dynamic = "force-dynamic";

function adminPin(): string | null {
  return process.env.ADMIN_PIN || null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const pin = adminPin();
  if (pin && (req.headers.get("x-admin-pin") || "") !== pin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { contactIds?: unknown; confirmReview?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const contactIds = Array.isArray(body.contactIds) ? body.contactIds.map(String) : [];

  try {
    const actor = (await currentActor()).label;
    const result = await mergeQuoContacts(contactIds, { actor, confirmReview: body.confirmReview === true });
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (e) {
    if (e instanceof QuoNotConfiguredError) {
      return NextResponse.json({ ok: false, reason: "Quo is not connected." }, { status: 503 });
    }
    return NextResponse.json(
      { ok: false, reason: `Quo error: ${e instanceof Error ? e.message : String(e)}. Refresh the list to see where this group stands.` },
      { status: 502 },
    );
  }
}
