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
import { STAGE_LABEL } from "@/lib/salesos/calc";
import { approvalExistsByKey, createApproval, type ApprovalActionType, type ApprovalCard } from "./approvals";

/** Cap per proposer run — bounded, never a flood. */
const MAX_PER_RUN = 6;

export interface ProposeResult {
  agent: string;
  candidates: number; // actionable items considered
  created: number; // new approval requests created
  skipped: number; // already proposed (idempotent) or no reachable channel
}

const money = (n: number | null | undefined): string => (n == null ? "an unknown amount" : "$" + Math.round(n).toLocaleString("en-US"));
const channelWord = (t: ApprovalActionType): string => (t === "send_email" ? "email" : "text");

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
    const body = draft?.draft.sms?.trim();
    if (!body) {
      skipped++;
      continue;
    }

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

    const key = `outreach:${lead.id}:${today}`;
    const existed = approvalExistsByKey(key);
    createApproval({
      agentId: "outreach",
      owner: "Jessie",
      title: `Follow-up ${channelWord(actionType)} to ${lead.clientName || lead.id}`,
      actionType,
      actionPayload: { transactionId: lead.id, leadId: lead.id, body, subject: "Following up on your event" },
      card,
      financial: false,
      idempotencyKey: key,
    });
    if (existed) skipped++;
    else created++;
  }
  return { agent: "outreach", candidates: candidates.length, created, skipped };
}

// ── Lost Quote — drafted win-back on a worthwhile lost deal ───────────────────────
export async function proposeLostQuoteApprovals(): Promise<ProposeResult> {
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
    const body = draft?.draft.sms?.trim();
    if (!body) {
      skipped++;
      continue;
    }

    const card: ApprovalCard = {
      what: `Send a win-back ${channelWord(actionType)} to ${q.clientName || "the client"}.`,
      why: `Lost quote worth ${money(q.value)}${q.lossReason ? `, loss reason: ${q.lossReason}` : ", loss reason untagged"}. Worth a win-back attempt.`,
      dataUsed: `Lost quote ${q.id}; status "${q.statusLabel}"; value ${money(q.value)}; event ${q.eventDate ?? "undated"}.`,
      expectedOutcome: "Re-open the conversation and recover a lost opportunity.",
      risk: "Customer-facing re-engagement on a lost deal. Confirm this client is appropriate to re-approach before approving.",
      whatIfApproved: whatIfLine(actionType),
    };

    const key = `lostquote:${q.id}`;
    const existed = approvalExistsByKey(key);
    createApproval({
      agentId: "lost-quote",
      owner: "Jessie",
      title: `Win-back ${channelWord(actionType)} to ${q.clientName || q.id}`,
      actionType,
      actionPayload: { transactionId: q.id, leadId: q.id, body, subject: "Checking back in about your event" },
      card,
      financial: true, // references a dollar value — $-redacted for non-financial roles
      idempotencyKey: key,
    });
    if (existed) skipped++;
    else created++;
  }
  return { agent: "lost-quote", candidates: candidates.length, created, skipped };
}
