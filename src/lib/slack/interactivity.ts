// Slack interactivity (Block Kit buttons) — PURE parsing + authorization + honest state rendering,
// unit-tested; the route stays thin. Slack POSTs a block_actions payload as application/x-www-form-urlencoded
// with a single `payload` field holding the JSON. We parse the clicked action + who clicked, map it to an
// approval decision, and gate WHO may decide to the SLACK_APPROVER_USER_IDS allowlist (fail-safe: empty →
// nobody, decisions stay in the app).

import type { ApprovalDecision, ApprovalStatus } from "@/lib/aiorg/approvals";

/** Block action_ids for the approval buttons (shared by the card builder + the route). Any workflow that wants
 *  Slack approve/dismiss/change-request buttons (payroll, exceptions, …) reuses THESE ids — the shared
 *  interactivity route reads them. Do not invent per-workflow ids. */
export const APPROVE_ACTION = "ai_approval_approve";
export const REJECT_ACTION = "ai_approval_reject";
export const REQUEST_CHANGES_ACTION = "ai_approval_request_changes";

export interface ParsedAction {
  actionId: string;
  value: string; //       the approval id carried on the button
  userId: string; //      the Slack user who clicked
  userName: string;
  responseUrl: string | null; // where to POST the updated message
  channel: string | null;
  messageTs: string | null;
}

/** Parse a Slack block_actions interactivity POST body (urlencoded `payload=<json>`). Null if not usable. */
export function parseInteractivity(rawBody: string): ParsedAction | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(rawBody).get("payload");
  } catch {
    return null;
  }
  if (!raw) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (p.type !== "block_actions") return null;
  const actions = Array.isArray(p.actions) ? (p.actions as Record<string, unknown>[]) : [];
  const a = actions[0];
  if (!a || typeof a.action_id !== "string") return null;
  const user = (p.user ?? {}) as Record<string, unknown>;
  const channel = (p.channel ?? {}) as Record<string, unknown>;
  const message = (p.message ?? {}) as Record<string, unknown>;
  return {
    actionId: a.action_id,
    value: typeof a.value === "string" ? a.value : "",
    userId: typeof user.id === "string" ? user.id : "",
    userName: typeof user.username === "string" ? user.username : typeof user.name === "string" ? user.name : "",
    responseUrl: typeof p.response_url === "string" ? p.response_url : null,
    channel: typeof channel.id === "string" ? channel.id : null,
    messageTs: typeof message.ts === "string" ? message.ts : null,
  };
}

/** The approval decision a button maps to, or null for an action we don't handle. "Request changes" maps to
 *  request_info: it does NOT edit source data from Slack — it sends the item back for a human to correct in
 *  the app (free-form corrections never mutate business rules / records straight from a button click). */
export function decisionForAction(actionId: string): ApprovalDecision | null {
  if (actionId === APPROVE_ACTION) return "approve";
  if (actionId === REJECT_ACTION) return "reject";
  if (actionId === REQUEST_CHANGES_ACTION) return "request_info";
  return null;
}

/** How a DECIDED approval should be shown on the updated Slack card. Driven by the approval's REAL stored
 *  status (never the latest click's intent), so a repeated or racing click always renders the true outcome —
 *  e.g. a reject click that lost a race to an earlier approve still shows "Approved", not a false "Dismissed".
 *  PURE — no DB, no env. */
export interface DecidedCardView {
  emoji: string;
  title: string;
  /** Label for the actor field, matched to the actual outcome. */
  byLabel: string;
}

export function decidedCardView(status: ApprovalStatus): DecidedCardView {
  switch (status) {
    case "queued": //     approved AND enqueued to the outbox — the honest post-approve state (WS03 lifecycle)
    case "executed": //   LEGACY (pre-WS03) rows stamped executed on enqueue — same meaning: queued to send
      return { emoji: "✅", title: "Approved — queued to send", byLabel: "Approved by" };
    case "confirmed": //  the drainer reported Goodshuffle ACCEPTED the write (NOT a recipient read receipt)
      return { emoji: "✅", title: "Sent — accepted by Goodshuffle", byLabel: "Approved by" };
    case "approved": //   approved but execution held (gate off / forbidden / no async path) — intent recorded
      return { emoji: "⏸️", title: "Approved — send held", byLabel: "Approved by" };
    case "rejected":
      return { emoji: "✖️", title: "Dismissed", byLabel: "Dismissed by" };
    case "failed": //     the execution step errored — the card must NOT claim success
      return { emoji: "⚠️", title: "Failed — not sent", byLabel: "Attempted by" };
    case "info_requested": // sent back for a human to correct in the app (no source change from Slack)
      return { emoji: "✏️", title: "Changes requested — open the app to edit", byLabel: "Requested by" };
    case "edited":
      return { emoji: "✏️", title: "Edited — awaiting approval", byLabel: "Edited by" };
    case "pending":
    default:
      return { emoji: "🕓", title: "Still pending", byLabel: "By" };
  }
}

/** Who may approve/decide from Slack. PURE: pass the allowlisted Slack user ids (the route resolves them from
 *  app settings via slackApproverIds(), which defaults to SLACK_APPROVER_USER_IDS). When `ids` is omitted it
 *  falls back to reading that env var directly — the original behavior, kept for simple callers/tests. Empty →
 *  NOBODY (fail-safe): the click returns a notice and the decision stays in the app. Executing an approved op
 *  sends to real customers, so this gate is deliberately strict + opt-in. */
export function isSlackApprover(userId: string, ids?: string[]): boolean {
  const list =
    ids ??
    (process.env.SLACK_APPROVER_USER_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return list.length > 0 && !!userId && list.includes(userId);
}
