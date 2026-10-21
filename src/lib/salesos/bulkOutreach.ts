// Bulk Review-and-Fire — the Quote-Sent cohort, worked in one pass. For every lead sitting in the
// "Quote Sent" board column this assembles: the quote facts (amount, sent date, days since), the last
// touch, and a REFRESHED next-step draft (reusing draftLeadOutreach — the same context-aware drafter the
// single lead panel uses; we do NOT write a new one). The owner reviews the table, selects rows/channels,
// and approves. Approval creates the EXACT SAME governed approval(s) a single approval does today
// (createApproval -> decideApproval): email -> gs_outbox email_send (gated by EMAIL_SEND_ENABLED); SMS is
// HELD (no async outbox op — it mirrors the single outreach SMS approval, which records intent and leaves
// delivery to the human Sales lead panel send, gated by SMS_SEND_ENABLED). NOTHING sends without the
// owner's approval click, every existing comms gate is respected, and the whole thing is idempotent:
// re-firing a row in the same day is a no-op (createApproval dedupes on the lead+channel+day key, and
// decideApproval never re-executes an already-decided request).

import { salesLeadCards } from "./board";
import { getLead } from "./service";
import { draftLeadOutreach } from "./outreachService";
import { stripSignOff, humanize } from "./outreach";
import { STAGE_LABEL } from "./calc";
import { todayInOpsTz } from "@/lib/dates";
import { getLatestOutboundForLead, getLatestCommsRowForLead } from "@/lib/db/repo";
import {
  createApproval,
  decideApproval,
  type ApprovalActionType,
  type ApprovalCard,
  type ApprovalStatus,
  type DecisionResult,
} from "@/lib/aiorg/approvals";

/** Default email subject for a quote-sent follow-up — matches the single-send outreach proposer. */
export const BULK_EMAIL_SUBJECT = "Following up on your event";

/** A row's last-outreach window: a lead touched within this many hours defaults to UNCHECKED ("recently
 *  contacted"), so the bulk pass never immediately chases someone just reached. The per-day idempotency
 *  key is the hard stop; this is the softer default-off nudge. */
export const RECENTLY_CONTACTED_HOURS = 24;

function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function hoursSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 3_600_000) : null;
}

function relativeWhen(iso: string | null, today: string): string {
  if (!iso) return "";
  const ymd = iso.slice(0, 10);
  const d = daysBetweenYmd(ymd, today);
  if (!Number.isFinite(d)) return ymd;
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  return `${d}d ago`;
}

export interface BulkLastTouch {
  what: string; // e.g. "Outbound text" / "Inbound email"
  when: string; // relative label (e.g. "3d ago")
  whenIso: string | null;
}

/** One quote-sent lead, with its refreshed drafts and honest per-channel availability. */
export interface BulkOutreachRow {
  leadId: string;
  clientName: string;
  eventName: string;
  eventDate: string | null;
  value: number | null;
  stageLabel: string;
  quoteSentDate: string | null;
  daysSinceQuote: number | null;
  lastTouch: BulkLastTouch | null;
  smsDraft: string | null; // the refreshed next-step text (null when drafting found no sensible step)
  emailSubject: string;
  emailDraft: string | null; // same copy, sign-off stripped (Goodshuffle appends the signature)
  smsAvailable: boolean; //   a phone is on file
  emailAvailable: boolean; // an email is on file
  recentlyContacted: boolean; // last outreach < RECENTLY_CONTACTED_HOURS → default unchecked
  draftFailed: boolean; //      no sensible next step → excluded by default
  // Suggested default selections (the owner can override every one). Off when unavailable, drafting
  // failed, or the lead was contacted very recently.
  defaultSms: boolean;
  defaultEmail: boolean;
  note: string | null; // honest one-line reason when a row is flagged/limited
}

export interface BulkOutreachCohort {
  today: string;
  rows: BulkOutreachRow[];
  emailGateOn: boolean; // EMAIL_SEND_ENABLED — when off, an approved email is recorded but not sent
  smsGateOn: boolean; //   SMS_SEND_ENABLED — the live Sales-panel SMS send gate
}

function rowNote(opts: { draftFailed: boolean; smsAvailable: boolean; emailAvailable: boolean; recentlyContacted: boolean }): string | null {
  if (opts.draftFailed) return "No sensible next step from the history — excluded by default.";
  if (!opts.smsAvailable && !opts.emailAvailable) return "No phone or email on file — cannot reach this client.";
  if (opts.recentlyContacted) return `Contacted within ${RECENTLY_CONTACTED_HOURS}h — unchecked by default.`;
  if (!opts.smsAvailable) return "No phone on file — SMS not available for this row.";
  if (!opts.emailAvailable) return "No email on file — email not available for this row.";
  return null;
}

/** Build the Quote-Sent cohort for the bulk panel: scoped to leads whose effective board status is
 *  `quote_sent`, each with a refreshed draft + honest availability + flags. `repFirstName` personalizes
 *  the draft opening, exactly as the single lead panel does. */
export async function buildBulkOutreachCohort(repFirstName?: string | null): Promise<BulkOutreachCohort> {
  const today = todayInOpsTz();
  const cohort = salesLeadCards().filter((c) => c.status === "quote_sent");

  const rows: BulkOutreachRow[] = [];
  for (const card of cohort) {
    const lead = getLead(card.id);
    const smsAvailable = (lead?.clientPhone ?? "").trim().length > 0;
    const emailAvailable = (lead?.clientEmail ?? "").trim().length > 0;

    // Refreshed next-step draft — the SAME context-aware drafter the single lead panel uses.
    const draft = await draftLeadOutreach(card.id, repFirstName);
    const body = draft?.draft.sms?.trim() || "";
    const draftFailed = body.length === 0;

    const lastOut = getLatestOutboundForLead(card.id);
    const recentlyContacted = (() => {
      const h = hoursSince(lastOut?.occurredAt ?? lastOut?.ts ?? null);
      return h != null && h < RECENTLY_CONTACTED_HOURS;
    })();

    const lastRow = getLatestCommsRowForLead(card.id);
    const lastTouch: BulkLastTouch | null = lastRow
      ? {
          what: `${lastRow.direction === "inbound" ? "Inbound" : "Outbound"} ${lastRow.channel || "message"}`.trim(),
          when: relativeWhen(lastRow.occurredAt ?? lastRow.ts, today),
          whenIso: lastRow.occurredAt ?? lastRow.ts ?? null,
        }
      : null;

    const note = rowNote({ draftFailed, smsAvailable, emailAvailable, recentlyContacted });
    const includeOk = !draftFailed && !recentlyContacted;

    rows.push({
      leadId: card.id,
      clientName: card.clientName,
      eventName: card.eventName,
      eventDate: card.eventDate,
      value: card.value,
      stageLabel: lead ? STAGE_LABEL[lead.stage] : card.statusLabel,
      quoteSentDate: card.quoteSentDate,
      daysSinceQuote: card.quoteSentDate ? daysBetweenYmd(card.quoteSentDate.slice(0, 10), today) : null,
      lastTouch,
      smsDraft: draftFailed ? null : humanize(body),
      emailSubject: BULK_EMAIL_SUBJECT,
      emailDraft: draftFailed ? null : stripSignOff(humanize(body)),
      smsAvailable,
      emailAvailable,
      recentlyContacted,
      draftFailed,
      defaultSms: includeOk && smsAvailable,
      defaultEmail: includeOk && emailAvailable,
      note,
    });
  }

  return {
    today,
    rows,
    emailGateOn: process.env.EMAIL_SEND_ENABLED === "true",
    smsGateOn: process.env.SMS_SEND_ENABLED === "true",
  };
}

// ── Queue approved (fire through the existing governed approval path) ─────────────────────────────────

const money = (n: number | null | undefined): string => (n == null ? "an unknown amount" : "$" + Math.round(n).toLocaleString("en-US"));
const channelWord = (t: ApprovalActionType): string => (t === "send_email" ? "email" : "text");

function whatIfLine(actionType: ApprovalActionType): string {
  return actionType === "send_email"
    ? "On approve, the drafted email is queued to the Goodshuffle client thread and sends on the next office Auto-Pull. Gated by EMAIL_SEND_ENABLED, so if that switch is off the decision is recorded but nothing is sent."
    : "On approve, the decision is recorded. The text itself delivers from the Sales lead panel send (gated by SMS_SEND_ENABLED); there is no async SMS outbox op, so it is never silently sent from here.";
}

/** The lead+channel+day idempotency key. Firing the same row/channel again the same day resolves to the
 *  same approval (and decideApproval then no-ops), so a re-fire never double-sends. */
export function bulkIdempotencyKey(leadId: string, channel: "email" | "sms", day: string): string {
  return `salesos-bulk:${leadId}:${channel}:${day}`;
}

function buildCard(row: { clientName: string; eventDate: string | null; value: number | null; stageLabel: string; daysSinceQuote: number | null }, actionType: ApprovalActionType): ApprovalCard {
  const eventWhen = row.eventDate ? `event on ${row.eventDate}` : "event";
  return {
    what: `Send a follow-up ${channelWord(actionType)} to ${row.clientName || "the client"} about their ${eventWhen}.`,
    why: `Quote Sent cohort, worked in one pass. Stage: ${row.stageLabel}.`,
    dataUsed: `Sales OS quote-sent lead; stage ${row.stageLabel}; days since quote ${row.daysSinceQuote ?? "unknown"}; potential value ${money(row.value)}.`,
    expectedOutcome: "Re-engage the client and move the quote toward a signature.",
    risk:
      (row.value ?? 0) >= 10000
        ? "Customer-facing message on a high-value deal. Review the wording carefully before approving."
        : "Customer-facing follow-up. Review the wording before approving.",
    whatIfApproved: whatIfLine(actionType),
  };
}

/** One selected row the owner approved, with the reviewed copy per channel. A channel is only fired when
 *  its body is present AND the client is actually reachable on it (re-validated server-side). */
export interface BulkQueueItem {
  leadId: string;
  clientName?: string;
  value?: number | null;
  eventDate?: string | null;
  email?: { subject?: string; body: string };
  sms?: { body: string };
}

export interface BulkChannelResult {
  channel: "email" | "sms";
  approvalId: string;
  outcome: DecisionResult["outcome"];
  status: ApprovalStatus;
  message: string;
}

export interface BulkQueueRowResult {
  leadId: string;
  clientName: string;
  channels: BulkChannelResult[];
  skipped: { channel: "email" | "sms"; reason: string }[];
}

export interface BulkQueueSummary {
  today: string;
  rows: BulkQueueRowResult[];
  queuedEmail: number; // enqueued to the outbox (gate on) — queued, NOT confirmed delivered
  heldEmail: number; //   approved but gate off — recorded, nothing enqueued
  heldSms: number; //     approved but held (no async SMS op)
  duplicates: number; //  re-fire of an already-decided row/channel (idempotent no-op)
  failed: number; //      the enqueue itself errored
  skipped: number; //     a requested channel that was unavailable or had no body
}

/** Fire the owner's approved selections through the EXISTING governed approval path. For each selected
 *  row+channel: createApproval (idempotent on the lead+channel+day key) then decideApproval("approve").
 *  This produces the identical governed op a single approval does — email_send queued (gate permitting),
 *  SMS held. `actor` is the human who clicked approve (recorded on the decision, never fabricated). */
export function queueBulkOutreach(items: BulkQueueItem[], actor: string): BulkQueueSummary {
  const today = todayInOpsTz();
  const rows: BulkQueueRowResult[] = [];
  let queuedEmail = 0;
  let heldEmail = 0;
  let heldSms = 0;
  let duplicates = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of items) {
    const leadId = (item.leadId ?? "").trim();
    if (!leadId) continue;
    // Re-validate reachability server-side — never trust the client for availability.
    const lead = getLead(leadId);
    const channels: BulkChannelResult[] = [];
    const rowSkipped: { channel: "email" | "sms"; reason: string }[] = [];

    if (!lead) {
      rows.push({ leadId, clientName: item.clientName ?? leadId, channels, skipped: [{ channel: "email", reason: "Lead not found." }] });
      skipped++;
      continue;
    }

    const clientName = lead.clientName || item.clientName || leadId;
    const cardBase = { clientName, eventDate: lead.eventDate ?? item.eventDate ?? null, value: lead.value ?? item.value ?? null, stageLabel: STAGE_LABEL[lead.stage], daysSinceQuote: lead.quoteSentDate ? daysBetweenYmd(lead.quoteSentDate.slice(0, 10), today) : null };

    // EMAIL — governed outbox op (email_send), gated by EMAIL_SEND_ENABLED inside decideApproval.
    if (item.email) {
      const body = stripSignOff((item.email.body ?? "").trim());
      if (!lead.clientEmail.trim()) {
        rowSkipped.push({ channel: "email", reason: "No email on file." });
        skipped++;
      } else if (!body) {
        rowSkipped.push({ channel: "email", reason: "Empty email body." });
        skipped++;
      } else {
        const key = bulkIdempotencyKey(leadId, "email", today);
        const appr = createApproval({
          agentId: "outreach",
          owner: actor,
          title: `Follow-up email to ${clientName}`,
          actionType: "send_email",
          actionPayload: { transactionId: leadId, leadId, body, subject: (item.email.subject ?? "").trim() || BULK_EMAIL_SUBJECT },
          card: buildCard(cardBase, "send_email"),
          financial: false,
          idempotencyKey: key,
        });
        const dec = decideApproval(appr.id, "approve", actor);
        channels.push({ channel: "email", approvalId: appr.id, outcome: dec.outcome, status: dec.approval.status, message: dec.message });
        if (dec.outcome === "executed_queued") queuedEmail++;
        else if (dec.outcome === "held_gate_off") heldEmail++;
        else if (dec.outcome === "already_decided") duplicates++;
        else if (dec.outcome === "failed") failed++;
      }
    }

    // SMS — mirrors the single outreach SMS approval: HELD (no async outbox op). Approving records the
    // governed decision; the text itself still delivers from the human Sales lead panel send.
    if (item.sms) {
      const body = (item.sms.body ?? "").trim();
      if (!lead.clientPhone.trim()) {
        rowSkipped.push({ channel: "sms", reason: "No phone on file." });
        skipped++;
      } else if (!body) {
        rowSkipped.push({ channel: "sms", reason: "Empty text body." });
        skipped++;
      } else {
        const key = bulkIdempotencyKey(leadId, "sms", today);
        const appr = createApproval({
          agentId: "outreach",
          owner: actor,
          title: `Follow-up text to ${clientName}`,
          actionType: "send_sms",
          actionPayload: { transactionId: leadId, leadId, body },
          card: buildCard(cardBase, "send_sms"),
          financial: false,
          idempotencyKey: key,
        });
        const dec = decideApproval(appr.id, "approve", actor);
        channels.push({ channel: "sms", approvalId: appr.id, outcome: dec.outcome, status: dec.approval.status, message: dec.message });
        if (dec.outcome === "already_decided") duplicates++;
        else if (dec.outcome === "held_no_path") heldSms++;
      }
    }

    rows.push({ leadId, clientName, channels, skipped: rowSkipped });
  }

  return { today, rows, queuedEmail, heldEmail, heldSms, duplicates, failed, skipped };
}
