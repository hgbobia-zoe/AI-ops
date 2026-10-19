// Slack interactivity (Block Kit buttons) — PURE parsing + authorization, unit-tested; the route stays thin.
// Slack POSTs a block_actions payload as application/x-www-form-urlencoded with a single `payload` field
// holding the JSON. We parse the clicked action + who clicked, map it to an approval decision, and gate WHO
// may decide to the SLACK_APPROVER_USER_IDS allowlist (fail-safe: empty → nobody, decisions stay in the app).

/** Block action_ids for the approval buttons (shared by the card builder + the route). */
export const APPROVE_ACTION = "ai_approval_approve";
export const REJECT_ACTION = "ai_approval_reject";

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

/** The approval decision a button maps to, or null for an action we don't handle. */
export function decisionForAction(actionId: string): "approve" | "reject" | null {
  if (actionId === APPROVE_ACTION) return "approve";
  if (actionId === REJECT_ACTION) return "reject";
  return null;
}

/** Who may approve/decide from Slack: the Slack user ids in SLACK_APPROVER_USER_IDS (comma-separated). Empty
 *  or unset → NOBODY (fail-safe) — clicking returns a notice and the decision stays in the app. Executing an
 *  approved op sends to real customers, so this gate is deliberately strict + opt-in. */
export function isSlackApprover(userId: string): boolean {
  const ids = (process.env.SLACK_APPROVER_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 && !!userId && ids.includes(userId);
}
