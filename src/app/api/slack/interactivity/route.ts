// Slack interactivity endpoint — receives Block Kit button clicks (Approve / Request changes / Dismiss on an
// AI approval card) and applies the decision through the SAME governance path as the app (decideApproval): the
// one shared handler every workflow (sales, payroll, exceptions, …) reuses. Security:
//   • Slack SIGNATURE verified (HMAC, replay-guarded) — once SLACK_SIGNING_SECRET is set, unsigned = 401.
//   • WHO may decide is gated to SLACK_APPROVER_USER_IDS (fail-safe: empty → nobody; the click returns a
//     notice and the decision stays in the app). Executing an approved op can message real customers.
// On success it UPDATES the original message (via response_url) to a decided card with the buttons removed.
// CORS-locked by the proxy allowlist; authenticates by signature, not a session.

import { NextResponse } from "next/server";
import { verifySlackSignature } from "@/lib/slack/verify";
import { parseInteractivity, decisionForAction, isSlackApprover, decidedCardView } from "@/lib/slack/interactivity";
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

  const who = action.userName || action.userId;
  const actor = `slack:${who}`;
  // "Request changes" records a note and routes the human to the app to specify the correction — it NEVER
  // edits the stored payload / source data straight from the button (a click is not proof of the change).
  const opts = decision === "request_info" ? { note: `Change requested from Slack by @${who}. Open the app to specify changes and re-approve.` } : {};
  const result = decideApproval(appr.id, decision, actor, opts);

  // Replace the original card with a decided one — buttons gone, outcome shown. Render from the approval's
  // REAL current status (not this click's intent) so a repeated / racing click shows the true outcome and
  // attributes it to whoever actually decided — never a false "Dismissed" over an already-approved item, and
  // never a green "Approved" when the execution step failed.
  const final = result.approval;
  const view = decidedCardView(final.status);
  const decider = final.decidedBy || actor;
  const blocks = cardBlocks({
    emoji: view.emoji,
    title: view.title,
    fields: [
      { label: "Item", value: appr.title },
      { label: view.byLabel, value: `@${decider.replace(/^slack:/, "")}` },
    ],
    body: result.message,
    context: "Decided from Slack",
  });
  if (action.responseUrl) {
    await respondToSlack(action.responseUrl, { replace_original: true, text: `${view.title}: ${appr.title}`, blocks });
  }
  return NextResponse.json({ ok: true });
}
