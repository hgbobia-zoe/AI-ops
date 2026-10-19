// AI Control Plane — the Session Bridge DRAIN QUEUE. A connected responder (an Agent-SDK worker or a Claude
// Code session) polls this to find sessions holding an unanswered human instruction, works each one, then
// claims + posts the result back via POST /api/ai/bridge. This endpoint is read-only: it NEVER mutates a
// session or executes anything. Auth is the same two-path gate as the bridge endpoint — an owner/admin
// browser cookie OR the shared x-bridge-token (only valid when AI_BRIDGE_TOKEN is configured).

import { NextResponse } from "next/server";
import { listPendingInstructions, countPendingInstructions, type PendingInstruction } from "@/lib/ai/sessions";
import { bridgeTokenValid, activeAiProviderId, bridgeConnected } from "@/lib/ai/provider";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";
import { assembleThreadContext } from "@/lib/ai/threadContext";

export const dynamic = "force-dynamic";

/** Owner/admin cookie OR a valid responder token. */
async function authorized(req: Request): Promise<boolean> {
  if (bridgeTokenValid(req.headers.get("x-bridge-token"))) return true;
  return canManageAi(await viewerRole());
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await authorized(req))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const n = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 20;

  // Attach each item's bounded thread transcript so the Tier-2 responder answers WITH conversation context
  // (the Slack thread — including Viktor's own earlier posts — merged with the in-DB timeline). The assembler
  // degrades honestly (Slack read fail → DB-only, flagged via slackRead) and never throws, so enrichment can
  // never break the drain queue. The instruction text itself is excluded from the transcript (it's carried
  // separately), so it isn't duplicated.
  const base = listPendingInstructions(limit);
  const pending: PendingInstruction[] = await Promise.all(
    base.map(async (p) => {
      try {
        const ctx = await assembleThreadContext({
          sessionId: p.sessionId,
          slack: p.slack ? { channel: p.slack.channel, threadTs: p.slack.threadTs } : null,
          excludeText: p.instruction,
        });
        return { ...p, transcript: ctx.turns, transcriptText: ctx.formatted, slackRead: ctx.slackRead };
      } catch {
        return p; // honest degrade: no transcript rather than a failed request
      }
    }),
  );

  return NextResponse.json({
    ok: true,
    pending,
    total: countPendingInstructions(),
    activeProvider: activeAiProviderId(),
    bridgeConnected: bridgeConnected(),
  });
}
