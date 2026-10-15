// Resolve a two-way-sync conflict on one shift — the write behind the /scheduling needs_review panel. The
// user picks the winner ("app" or "connecteam"); this applies that version (pull Connecteam->app, or push
// app->Connecteam SILENTLY) and clears sync_status to 'synced'. Owner/admin only (mirrors the publish gate),
// and it audits every outcome. Honest: a Connecteam write that fails leaves the flag in place and 502s.

import { NextResponse } from "next/server";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { resolveNeedsReview, type ResolveWinner } from "@/lib/scheduling/needsReview";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  if (!canManageSettings(await viewerRole())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { winner?: string };
  try {
    body = (await req.json()) as { winner?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const winner = body.winner;
  if (winner !== "app" && winner !== "connecteam") {
    return NextResponse.json({ error: "bad_winner", message: "Choose 'app' or 'connecteam'." }, { status: 400 });
  }

  const actor = (await currentActor()).label;
  const r = await resolveNeedsReview(id, winner as ResolveWinner, actor);
  if (!r.ok) {
    // not_found -> 404; not_flagged/unresolvable -> 409; a failed Connecteam write -> 502.
    const status = r.error === "not_found" ? 404 : r.error === "not_flagged" || r.error === "unresolvable" ? 409 : 502;
    return NextResponse.json({ error: r.error ?? "resolve_failed", message: r.message }, { status });
  }
  return NextResponse.json({ ok: true, action: r.action });
}
