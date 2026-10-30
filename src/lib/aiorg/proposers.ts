// AI Org v2 — bounded proposal generation. Wires a SMALL initial set of AI employees to CREATE
// approval requests from their REAL existing drafts/signals. Human-triggered (the "Draft & propose"
// buttons on the Approvals page) and CAPPED (never an unbounded auto-generator). The six card fields
// are filled DETERMINISTICALLY from the real lead/quote facts; only the message body is drawn from the
// existing draft generator (LLM-phrased only where draftLeadOutreach already does so, with a
// deterministic template floor). Respects each employee's toolbox: only APPROVAL_REQUIRED comms
// tools become proposals.

import { salesLeads, getLead } from "@/lib/salesos/service";
import { lostQuotesOverview } from "@/lib/salesos/lostService";
import { draftLeadOutreach } from "@/lib/salesos/outreachService";
import { stripSignOff } from "@/lib/salesos/outreach";
import { lastThreadMessageForLead } from "@/lib/salesos/timeline";
import { STAGE_LABEL } from "@/lib/salesos/calc";
import { getSettings } from "@/lib/settings";
import { approvalExistsByKey, createApproval, type ApprovalActionType, type ApprovalCard } from "./approvals";
import { describeLastMessageWho, formatLastMessageWhen, type LastMessageSnapshot } from "./lastMessage";
import { botAnnounce, appUrl } from "@/lib/notify/aiBots";
import { APPROVE_ACTION, REJECT_ACTION } from "@/lib/slack/interactivity";

/** Cap per proposer run — bounded, never a flood. */
const MAX_PER_RUN = 6;

/** Operator paused this agent from the org chart? A paused agent proposes NOTHING (the pause is an
 *  operational on/off switch honored here, not just a display flag). Best-effort: unreadable settings
 *  default to not-paused so the normal path keeps working. */
function agentPaused(id: string): boolean {
  try {
    return (getSettings().aiPaused ?? []).includes(id);
  } catch {
    return false;
  }
}

/** An empty result for a paused (or otherwise no-op) proposer run. */
const noRun = (agent: string): ProposeResult => ({ agent, candidates: 0, created: 0, skipped: 0 });

export interface ProposeResult {
  agent: string;
  candidates: number; // actionable items considered
  created: number; // new approval requests created
  skipped: number; // already proposed (idempotent) or no reachable channel
}

const money = (n: number | null | undefined): string => (n == null ? "an unknown amount" : "$" + Math.round(n).toLocaleString("en-US"));
const channelWord = (t: ApprovalActionType): string => (t === "send_email" ? "email" : "text");

/** A Slack-mrkdwn preview of the ACTUAL message to be sent, so the approver sees exactly what they're
 *  approving (the card previously showed only the "why", not the drafted copy). Email also shows the subject.
 *  The body is rendered as a blockquote; long drafts are truncated to keep the card readable. */
function draftPreview(actionType: ApprovalActionType, body: string, subject: string): string {
  const MAX = 900;
  const text = body.length > MAX ? body.slice(0, MAX).trimEnd() + "…" : body;
  const quoted = text.split("\n").map((l) => `> ${l}`).join("\n");
  const head = actionType === "send_email" ? `> *Subject:* ${subject}\n` : "";
  return `*Drafted ${channelWord(actionType)}:*\n${head}${quoted}`;
}

/** A Slack-mrkdwn "in reply to" block: the last message in the client's thread, so the approver sees what
 *  the drafted reply is responding to. Null when there is no prior message (nothing fabricated). */
function lastMessageBlock(lm: LastMessageSnapshot | null, clientName: string): string | null {
  if (!lm) return null;
  const when = formatLastMessageWhen(lm);
  const head = `${describeLastMessageWho(lm, clientName)}${when ? ` · ${when}` : ""}`;
  const MAX = 300;
  const body = lm.snippet ? (lm.snippet.length > MAX ? lm.snippet.slice(0, MAX).trimEnd() + "…" : lm.snippet) : null;
  const quoted = body ? "\n" + body.split("\n").map((l) => `> ${l}`).join("\n") : "";
  return `*In reply to (last message):*\n> ${head}${quoted}`;
}

/** Pick the reachable, wired-first channel from the contact facts (email is fully outbox-wired; SMS is
 *  held). Null when there is no way to reach the client. */
function pickChannel(hasEmail: boolean, hasPhone: boolean): ApprovalActionType | null {
  if (hasEmail) return "send_email";
  if (hasPhone) return "send_sms";
  return null;
}

function whatIfLine(actionType: ApprovalActionType): string {
  return actionType === "send_email"
    ? "On approve, the drafted email is queued to the Goodshuffle client thread and sends on the next office Auto-Pull. Gated by EMAIL_SEND_ENABLED, so if that switch is off the decision is recorded but nothing is sent."
    : "On approve, the decision is recorded. The text itself delivers from the Sales lead panel send (gated by SMS_SEND_ENABLED); there is no async SMS outbox op, so it is never silently sent from here.";
}

// ── Outreach — drafted follow-up on an open, actionable lead ─────────────────────
export async function proposeOutreachApprovals(): Promise<ProposeResult> {
  if (agentPaused("outreach")) return noRun("outreach");
  const overview = salesLeads();
  const today = overview.today;
  // Only leads the worklist says to act on now/today — deterministic, not a sweep of the whole pipeline.
  const candidates = overview.leads.filter((l) => l.action.urgency === "now" || l.action.urgency === "today").slice(0, MAX_PER_RUN);

  let created = 0;
  let skipped = 0;
  for (const lead of candidates) {
    const actionType = pickChannel(lead.clientEmail.trim().length > 0, lead.clientPhone.trim().length > 0);
    if (!actionType) {
      skipped++;
      continue;
    }
    const draft = await draftLeadOutreach(lead.id);
    let body = draft?.draft.sms?.trim();
    if (!body) {
      skipped++;
      continue;
    }
    // EMAIL goes out through the Goodshuffle path, which appends the company signature, so drop any
    // AI-drafted closing from the email body (greeting kept). SMS keeps its draft as-is.
    if (actionType === "send_email") body = stripSignOff(body);

    const eventWhen = lead.eventDate ? `event on ${lead.eventDate}` : "event";
    const stageLabel = STAGE_LABEL[lead.stage];
    const card: ApprovalCard = {
      what: `Send a follow-up ${channelWord(actionType)} to ${lead.clientName || "the client"} about their ${eventWhen}.`,
      why: `${lead.action.reason} Stage: ${stageLabel}.`,
      dataUsed: `Sales OS lead ${lead.id}; stage ${stageLabel}; quote age ${lead.signals.quoteAgeDays ?? "unknown"} days; days to event ${lead.signals.daysToEvent ?? "n/a"}; potential value ${money(lead.value)}.`,
      expectedOutcome: "Re-engage the client and move the quote toward a signature.",
      risk:
        (lead.value ?? 0) >= 10000
          ? "Customer-facing message on a high-value deal. Review the wording carefully before approving."
          : "Customer-facing follow-up. Review the wording before approving.",
      whatIfApproved: whatIfLine(actionType),
    };

    // Snapshot the last message in the client's thread (what this reply is responding to) ONTO the
    // approval, so the approver sees the context without a live lookup. Null when there's no prior message.
    const lastMessage = lastThreadMessageForLead(lead.id);

    const key = `outreach:${lead.id}:${today}`;
    const existed = approvalExistsByKey(key);
    const appr = createApproval({
      agentId: "outreach",
      owner: "Jessie",
      title: `Follow-up ${channelWord(actionType)} to ${lead.clientName || lead.id}`,
      actionType,
      actionPayload: { transactionId: lead.id, leadId: lead.id, body, subject: "Following up on your event", lastMessage: lastMessage ?? undefined },
      card,
      financial: false,
      idempotencyKey: key,
    });
    if (existed) skipped++;
    else {
      created++;
      const lmBlock = lastMessageBlock(lastMessage, lead.clientName || "the client");
      void botAnnounce("sales", {
        emoji: "✍️",
        title: "Follow-up drafted — ready for approval",
        fields: [
          { label: "Client", value: lead.clientName || "the client" },
          { label: "Value", value: money(lead.value) },
          { label: "Channel", value: channelWord(actionType) },
          { label: "Event", value: lead.eventDate ?? "undated" },
        ],
        sections: lmBlock ? [lmBlock] : undefined,
        body: `${draftPreview(actionType, body, "Following up on your event")}\n\n*Why:* ${lead.action.reason}`,
        buttons: [
          { text: "Approve & send", actionId: APPROVE_ACTION, value: appr.id, style: "primary" },
          { text: "Dismiss", actionId: REJECT_ACTION, value: appr.id, style: "danger" },
        ],
        link: { text: "Open to edit", url: appUrl("/ai-org/approvals") },
        context: "Sales Bot · nothing is sent until you approve",
      }).catch(() => {});
    }
  }
  return { agent: "outreach", candidates: candidates.length, created, skipped };
}

// ── Lost Quote — drafted win-back on a worthwhile lost deal ───────────────────────
export async function proposeLostQuoteApprovals(): Promise<ProposeResult> {
  if (agentPaused("lost-quote")) return noRun("lost-quote");
  const overview = lostQuotesOverview();
  // Win-back candidates: lost quotes worth re-approaching (deterministic $ floor), biggest first.
  const candidates = overview.lost
    .filter((q) => q.value != null && q.value >= 2000)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, MAX_PER_RUN);

  let created = 0;
  let skipped = 0;
  for (const q of candidates) {
    const lead = getLead(q.id);
    if (!lead) {
      skipped++;
      continue;
    }
    const actionType = pickChannel(lead.clientEmail.trim().length > 0, lead.clientPhone.trim().length > 0);
    if (!actionType) {
      skipped++;
      continue;
    }
    const draft = await draftLeadOutreach(q.id);
    let body = draft?.draft.sms?.trim();
    if (!body) {
      skipped++;
      continue;
    }
    // EMAIL goes out through the Goodshuffle path (appends the signature); strip any AI closing. SMS stays.
    if (actionType === "send_email") body = stripSignOff(body);

    const card: ApprovalCard = {
      what: `Send a win-back ${channelWord(actionType)} to ${q.clientName || "the client"}.`,
      why: `Lost quote worth ${money(q.value)}${q.lossReason ? `, loss reason: ${q.lossReason}` : ", loss reason untagged"}. Worth a win-back attempt.`,
      dataUsed: `Lost quote ${q.id}; status "${q.statusLabel}"; value ${money(q.value)}; event ${q.eventDate ?? "undated"}.`,
      expectedOutcome: "Re-open the conversation and recover a lost opportunity.",
      risk: "Customer-facing re-engagement on a lost deal. Confirm this client is appropriate to re-approach before approving.",
      whatIfApproved: whatIfLine(actionType),
    };

    // Snapshot the last message in the client's thread (the context the win-back responds to) onto the
    // approval. Null when there's no prior message.
    const lastMessage = lastThreadMessageForLead(q.id);

    const key = `lostquote:${q.id}`;
    const existed = approvalExistsByKey(key);
    const appr = createApproval({
      agentId: "lost-quote",
      owner: "Jessie",
      title: `Win-back ${channelWord(actionType)} to ${q.clientName || q.id}`,
      actionType,
      actionPayload: { transactionId: q.id, leadId: q.id, body, subject: "Checking back in about your event", lastMessage: lastMessage ?? undefined },
      card,
      financial: true, // references a dollar value — $-redacted for non-financial roles
      idempotencyKey: key,
    });
    if (existed) skipped++;
    else {
      created++;
      const lmBlock = lastMessageBlock(lastMessage, q.clientName || "the client");
      void botAnnounce("sales", {
        emoji: "✍️",
        title: "Win-back drafted — ready for approval",
        fields: [
          { label: "Client", value: q.clientName || "the client" },
          { label: "Lost value", value: money(q.value) },
          { label: "Channel", value: channelWord(actionType) },
          { label: "Event", value: q.eventDate ?? "undated" },
        ],
        sections: lmBlock ? [lmBlock] : undefined,
        body: `${draftPreview(actionType, body, "Checking back in about your event")}\n\n${q.lossReason ? `*Loss reason:* ${q.lossReason}` : "Loss reason untagged."}`,
        buttons: [
          { text: "Approve & send", actionId: APPROVE_ACTION, value: appr.id, style: "primary" },
          { text: "Dismiss", actionId: REJECT_ACTION, value: appr.id, style: "danger" },
        ],
        link: { text: "Open to edit", url: appUrl("/ai-org/approvals") },
        context: "Sales Bot · nothing is sent until you approve",
      }).catch(() => {});
    }
  }
  return { agent: "lost-quote", candidates: candidates.length, created, skipped };
}
