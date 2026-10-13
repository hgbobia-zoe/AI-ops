// AI Control Plane — the responder's PROPOSE endpoint. The operational path needs the headless responder to
// raise an approval CARD (not execute anything): it classifies a Slack/session instruction as operational,
// drafts the action, and POSTs it here. This ONLY creates a pending ai_approvals row via the EXISTING
// proposeFromSession → createApproval (same six-field card, same idempotency, same action types) and links
// it to the session (which flips to awaiting_approval). It NEVER decides or executes — a human still decides
// it via the human-only /api/ai/approvals/decide, and the forbidden categories in approvals.ts
// (money/pricing/schedule/hiring/instawork) stay FORBIDDEN to execute there. This route adds no new power;
// it just lets the responder PUT work in front of a human.
//
// Auth: the shared x-bridge-token (valid only when AI_BRIDGE_TOKEN is set) OR an owner/admin browser cookie —
// the same two-path gate as /api/ai/bridge. Admitted through the proxy via isHeadlessTokenPath for a
// token-only (cookie-less) responder.

import { NextResponse } from "next/server";
import { proposeFromSession } from "@/lib/ai/propose";
import { bridgeTokenValid } from "@/lib/ai/provider";
import type { NewApproval, ApprovalActionType, ApprovalCard } from "@/lib/aiorg/approvals";
import { currentActor, viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const ACTION_TYPES: ApprovalActionType[] = [
  "send_email",
  "send_sms",
  "append_note",
  "create_gs_task",
  "modify_quote",
  "change_pricing",
  "schedule_change",
  "hiring",
  "firing",
  "instawork_gig",
];

const CARD_FIELDS: (keyof ApprovalCard)[] = ["what", "why", "dataUsed", "expectedOutcome", "risk", "whatIfApproved"];

function asCard(v: unknown): ApprovalCard | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const card: Partial<ApprovalCard> = {};
  for (const f of CARD_FIELDS) {
    if (typeof o[f] !== "string") return null;
    card[f] = o[f] as string;
  }
  return card as ApprovalCard;
}

export async function POST(req: Request): Promise<NextResponse> {
  const tokenAuthed = bridgeTokenValid(req.headers.get("x-bridge-token"));
  if (!tokenAuthed && !canManageAi(await viewerRole())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    sessionId?: string;
    agentId?: string;
    owner?: string;
    title?: string;
    actionType?: string;
    actionPayload?: Record<string, unknown>;
    card?: unknown;
    financial?: boolean;
    idempotencyKey?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const sessionId = (body.sessionId ?? "").trim();
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  const title = (body.title ?? "").trim();
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
  const actionType = body.actionType as ApprovalActionType | undefined;
  if (!actionType || !ACTION_TYPES.includes(actionType)) return NextResponse.json({ error: "bad_actionType" }, { status: 400 });
  const card = asCard(body.card);
  if (!card) return NextResponse.json({ error: "card must have all six string fields" }, { status: 400 });
  const idempotencyKey = (body.idempotencyKey ?? "").trim();
  if (!idempotencyKey) return NextResponse.json({ error: "idempotencyKey required" }, { status: 400 });

  // A token-authed headless responder has no cookie identity; attribute its proposal to "AI responder".
  const actor = tokenAuthed ? "AI responder" : (await currentActor()).label;

  const input: NewApproval = {
    agentId: (body.agentId ?? "viktor").trim() || "viktor",
    owner: (body.owner ?? actor).trim() || actor,
    title,
    actionType,
    actionPayload: body.actionPayload ?? {},
    card,
    financial: body.financial === true,
    idempotencyKey,
  };

  const approval = proposeFromSession(sessionId, input, actor);
  if (!approval) return NextResponse.json({ error: "session not found or closed" }, { status: 404 });

  return NextResponse.json({ ok: true, approval: { id: approval.id, status: approval.status } });
}
