// "Act on a call" endpoint, for in-app use (and a future "Act on this call" button). It resolves a finished
// Quo call, interprets it (reusing the coaching recap) and raises approve-first action cards. It NEVER
// executes anything itself: every card waits for a human approval, and money stays human-committed.
//
// Slack goes through Viktor's in-app act_on_call tool instead (src/lib/ai/viktor/tools.ts), so this route
// needs no headless token: it is a normal signed-in owner/admin call, like /api/ai-org/propose.

import { NextResponse } from "next/server";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { actOnCall } from "@/lib/calls/actOnCall";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const role = await viewerRole();
  if (!canManageSettings(role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { callId?: string; contact?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // An empty body acts on the most recent call with a transcript.
  }
  const actor = await currentActor();
  const result = await actOnCall({
    callId: body.callId?.trim() || undefined,
    contactQuery: body.contact?.trim() || undefined,
    requestedBy: actor.label,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
