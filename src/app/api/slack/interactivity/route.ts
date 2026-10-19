// Slack interactivity endpoint — receives Block Kit button clicks (Approve / Dismiss on an AI approval card)
// and applies the decision through the SAME governance path as the app (decideApproval). Security:
//   • Slack SIGNATURE verified (HMAC, replay-guarded) — once SLACK_SIGNING_SECRET is set, unsigned = 401.
//   • WHO may decide is gated to SLACK_APPROVER_USER_IDS (fail-safe: empty → nobody; the click returns a
//     notice and the decision stays in the app). Executing an approved op can message real customers.
// On success it UPDATES the original message (via response_url) to a decided card with the buttons removed.
// CORS-locked by the proxy allowlist; authenticates by signature, not a session.

import { NextResponse } from "next/server";
import { verifySlackSignature } from "@/lib/slack/verify";
import { parseInteractivity, decisionForAction, isSlackApprover } from "@/lib/slack/interactivity";
import { decideApproval, getApproval } from "@/lib/aiorg/approvals";
import { cardBlocks } from "@/lib/notify/aiBots";

export const dynamic = "force-dynamic";

/** Post an updated / ephemeral message back to Slack via the interaction's response_url. Never throws. */
async function respondToSlack(responseUrl: string, body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    /* best effort */
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();
  const v = verifySlackSignature(
    process.env.SLACK_SIGNING_SECRET,
    req.headers.get("x-slack-request-timestamp"),
    raw,
    req.headers.get("x-slack-signature"),
  );
  if (process.env.SLACK_SIGNING_SECRET && !v.verified) {
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  const action = parseInteractivity(raw);
  if (!action) return NextResponse.json({ ok: true }); // nothing actionable — ack so Slack doesn't retry

  const decision = decisionForAction(action.actionId);
  if (!decision) return NextResponse.json({ ok: true });

  // Gate WHO may decide. Not an approver → tell just them (ephemeral), change nothing.
  if (!isSlackApprover(action.userId)) {
    if (action.responseUrl) {
      await respondToSlack(action.responseUrl, {
        response_type: "ephemeral",
        replace_original: false,
        text: ":lock: You're not set up to approve from Slack. Open the approvals page in the app to decide, or ask an admin to add you to SLACK_APPROVER_USER_IDS.",
      });
    }
    return NextResponse.json({ ok: true });
  }

  const appr = getApproval(action.value);
  if (!appr) {
    if (action.responseUrl) await respondToSlack(action.responseUrl, { response_type: "ephemeral", replace_original: false, text: "That approval no longer exists." });
    return NextResponse.json({ ok: true });
  }

  const actor = `slack:${action.userName || action.userId}`;
  const result = decideApproval(appr.id, decision, actor);

  // Replace the original card with a decided one — buttons gone, outcome shown.
  const approved = decision === "approve";
  const blocks = cardBlocks({
    emoji: approved ? "✅" : "✖️",
    title: approved ? "Approved" : "Dismissed",
    fields: [
      { label: "Item", value: appr.title },
      { label: approved ? "Approved by" : "Dismissed by", value: `@${action.userName || action.userId}` },
    ],
    body: result.message,
    context: "Decided from Slack",
  });
  if (action.responseUrl) {
    await respondToSlack(action.responseUrl, { replace_original: true, text: `${approved ? "Approved" : "Dismissed"}: ${appr.title}`, blocks });
  }
  return NextResponse.json({ ok: true });
}
