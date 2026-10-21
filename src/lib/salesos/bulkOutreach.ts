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
import type { LeadCard, BoardStatus } from "./boardTypes";
import { getLead } from "./service";
import { draftLeadOutreach } from "./outreachService";
import { stripSignOff, humanize } from "./outreach";
import { STAGE_LABEL } from "./calc";
import { todayInOpsTz } from "@/lib/dates";
import { leadTouchContext, type LeadTouchpoint } from "./timeline";
import { createApproval, decideApproval, type ApprovalActionType, type ApprovalCard } from "@/lib/aiorg/approvals";
import { sendLeadSms } from "./smsSend";

/** Default email subject for a quote-sent follow-up — matches the single-send outreach proposer. */
export const BULK_EMAIL_SUBJECT = "Following up on your event";

/** A row's last-outreach window: a lead touched within this many hours defaults to UNCHECKED ("recently
 *  contacted"), so the bulk pass never immediately chases someone just reached. The per-day idempotency
 *  key is the hard stop; this is the softer default-off nudge. */
export const RECENTLY_CONTACTED_HOURS = 24;

// The cockpit works EVERY open lead with a quote out — not just the "recent" slice. Goodshuffle has one
// "Quote Sent" stage; our board auto-splits it into quote_sent (recent), follow_up (dormant >= 4 days) and
// action_needed (the client replied). All three are open quotes awaiting movement, so all three belong in
// the bulk pass; `new` (no quote yet) and `signed` do not. (lost/cancelled never reach salesLeadCards.)
const OPEN_QUOTE_STATUSES = new Set<BoardStatus>(["quote_sent", "follow_up", "action_needed"]);

// A quote is actually "out" when we have a quote-sent date OR the Goodshuffle status label says so — the
// SAME signal `autoStatus` keys its `sent` test off. This guards the one case where a board status in the
// set above can exist WITHOUT a quote: action_needed (a brand-new inbound reply before any quote). Those
// stay in the "New" cohort, not here.
const QUOTE_OUT_LABEL = /sent|proposal|quote|contract|review/i;
function hasQuoteOut(c: LeadCard): boolean {
  return !!c.quoteSentDate || QUOTE_OUT_LABEL.test(c.statusLabel);
}

/** The at-a-glance sub-status chip label for an open-quote row — the board nuance Goodshuffle flattens. */
export const SUBSTATUS_LABEL: Record<"quote_sent" | "follow_up" | "action_needed", string> = {
  quote_sent: "Recent",
  follow_up: "Needs follow-up",
  action_needed: "Replied",
};
export type OpenQuoteSubStatus = keyof typeof SUBSTATUS_LABEL;

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
  subStatus: OpenQuoteSubStatus; // which open-quote bucket this lead is in (board nuance)
  subStatusLabel: string; //        the chip label: "Recent" / "Needs follow-up" / "Replied"
  replied: boolean; //              action_needed — the client replied; needs a tailored response, default off
  quoteSentDate: string | null;
  daysSinceQuote: number | null;
  lastTouch: BulkLastTouch | null;
  touchpoints: LeadTouchpoint[]; //    bounded, chronological per-lead touch strip (oldest → newest)
  touchpointsEarlier: number; //       real touches older than the bounded strip (for a "+K earlier" chip)
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

function rowNote(opts: { draftFailed: boolean; smsAvailable: boolean; emailAvailable: boolean; recentlyContacted: boolean; replied: boolean }): string | null {
  if (opts.draftFailed) return "No sensible next step from the history — excluded by default.";
  if (!opts.smsAvailable && !opts.emailAvailable) return "No phone or email on file — cannot reach this client.";
  // Safety first: a client who just replied needs a tailored response, not a generic follow-up. The draft
  // is context-aware (it reads the reply), but the owner must opt in deliberately — so default off and say why.
  if (opts.replied) return "Client replied — review the tailored draft carefully; unchecked by default.";
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
  // EVERY open lead with a quote out (quote_sent + follow_up + action_needed), not just the recent slice —
  // the dormant and replied quotes are exactly the ones that most need a nudge. See OPEN_QUOTE_STATUSES.
  const cohort = salesLeadCards().filter((c) => OPEN_QUOTE_STATUSES.has(c.status as BoardStatus) && hasQuoteOut(c));

  const rows: BulkOutreachRow[] = [];
  for (const card of cohort) {
    const lead = getLead(card.id);
    const smsAvailable = (lead?.clientPhone ?? "").trim().length > 0;
    const emailAvailable = (lead?.clientEmail ?? "").trim().length > 0;

    // Refreshed next-step draft — the SAME context-aware drafter the single lead panel uses.
    const draft = await draftLeadOutreach(card.id, repFirstName);
    const body = draft?.draft.sms?.trim() || "";
    const draftFailed = body.length === 0;

    // Last touch + recently-contacted + the touch-point strip all derive from the FULL merged timeline
    // (comms + calls + emails + the Goodshuffle note log + the quote-send), NOT just the comms_events rows —
    // so a quoted/worked lead never shows "none logged", the double-contact guard sees the quote-send / rep
    // touches, and the under-row viz shows the real conversation. ONE buildLeadTimeline pass per lead.
    const touch = leadTouchContext(card.id);
    const recentlyContacted = (() => {
      const h = hoursSince(touch.lastOutboundAt);
      return h != null && h < RECENTLY_CONTACTED_HOURS;
    })();

    const subStatus = card.status as OpenQuoteSubStatus; // guaranteed in-set by the cohort filter above
    const replied = subStatus === "action_needed"; //        the client replied — safety default-off

    const lastTouch: BulkLastTouch | null = touch.lastTouch
      ? {
          what: touch.lastTouch.what,
          // Dated entries get a relative label ("3d ago"); an undated internal-note line keeps its date
          // token exactly as the team wrote it ("9/7") — never a fabricated instant.
          when: touch.lastTouch.whenIso ? relativeWhen(touch.lastTouch.whenIso, today) : touch.lastTouch.rawDate ?? "",
          whenIso: touch.lastTouch.whenIso,
        }
      : null;

    const note = rowNote({ draftFailed, smsAvailable, emailAvailable, recentlyContacted, replied });
    // A replied ("Action Needed") row defaults OFF for safety, exactly like a recently-contacted one — the
    // owner opts in after reading the tailored draft. Other guardrails (no-phone, recently-contacted) stand.
    const includeOk = !draftFailed && !recentlyContacted && !replied;

    rows.push({
      leadId: card.id,
      clientName: card.clientName,
      eventName: card.eventName,
      eventDate: card.eventDate,
      value: card.value,
      stageLabel: lead ? STAGE_LABEL[lead.stage] : card.statusLabel,
      subStatus,
      subStatusLabel: SUBSTATUS_LABEL[subStatus],
      replied,
      quoteSentDate: card.quoteSentDate,
      daysSinceQuote: card.quoteSentDate ? daysBetweenYmd(card.quoteSentDate.slice(0, 10), today) : null,
      lastTouch,
      touchpoints: touch.touchpoints,
      touchpointsEarlier: touch.touchpointsEarlier,
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

/** The display status for one fired channel. Email uses the approval lifecycle (queued / approved-held);
 *  SMS reflects the REAL live send (sent / failed / held when the gate is off / already_sent on re-fire). */
export type BulkChannelStatus = "queued" | "approved" | "sent" | "failed" | "held" | "already_sent";

export interface BulkChannelResult {
  channel: "email" | "sms";
  approvalId: string;
  status: BulkChannelStatus;
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
  sentSms: number; //     text actually delivered via the gated Quo sender
  failedSms: number; //   the provider rejected the text (shown with its reason)
  heldSms: number; //     approved but held — SMS_SEND_ENABLED is off, nothing sent
  duplicates: number; //  re-fire of an already-decided/already-sent row/channel (idempotent no-op)
  failed: number; //      an email outbox enqueue itself errored
  skipped: number; //     a requested channel that was unavailable or had no body
}

/** Fire the owner's approved selections. For each selected row+channel it first records the governed
 *  approval (createApproval, idempotent on the lead+channel+day key, then decideApproval("approve") for
 *  the audit trail), then actually delivers:
 *   • EMAIL → the governed gs_outbox email_send op (gate EMAIL_SEND_ENABLED) — identical to a single approval.
 *   • SMS   → the app's own sanctioned live sender (sendLeadSms → /api/salesos/send-sms's path), gated by
 *            SMS_SEND_ENABLED. Gate on → the text actually sends (sent / failed shown honestly); gate off →
 *            held, nothing sent. Idempotent: a re-fire the same day resolves to the already-decided approval,
 *            so the send is skipped and never double-texts.
 *  `actor` is the human who clicked approve. `sms` carries the resolved Quo sender attribution (never
 *  impersonation — the signed-in owner's own linked rep), passed straight through to sendLeadSms. */
export async function queueBulkOutreach(
  items: BulkQueueItem[],
  actor: string,
  sms: { userId?: string; initials?: string | null } = {},
): Promise<BulkQueueSummary> {
  const today = todayInOpsTz();
  const rows: BulkQueueRowResult[] = [];
  let queuedEmail = 0;
  let heldEmail = 0;
  let sentSms = 0;
  let failedSms = 0;
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
        if (dec.outcome === "executed_queued") {
          queuedEmail++;
          channels.push({ channel: "email", approvalId: appr.id, status: "queued", message: dec.message });
        } else if (dec.outcome === "held_gate_off") {
          heldEmail++;
          channels.push({ channel: "email", approvalId: appr.id, status: "held", message: dec.message });
        } else if (dec.outcome === "already_decided") {
          duplicates++;
          channels.push({ channel: "email", approvalId: appr.id, status: "already_sent", message: "Already queued today — not re-queued." });
        } else if (dec.outcome === "failed") {
          failed++;
          channels.push({ channel: "email", approvalId: appr.id, status: "failed", message: dec.message });
        } else {
          channels.push({ channel: "email", approvalId: appr.id, status: "approved", message: dec.message });
        }
      }
    }

    // SMS — the governed approval is still recorded (audit trail) via createApproval + decideApproval,
    // then the text is ACTUALLY sent through the app's own sanctioned gated sender (sendLeadSms), the same
    // path the single lead-panel send uses. The bulk approval key makes it idempotent: a fresh approve
    // (held_no_path) proceeds to send once; a same-day re-fire (already_decided) is skipped, never
    // double-texting. SMS_SEND_ENABLED off → sendLeadSms sends nothing and the row is honestly held.
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
        if (dec.outcome === "already_decided") {
          // Idempotent: this row+channel was already approved/sent today — do not text again.
          duplicates++;
          channels.push({ channel: "sms", approvalId: appr.id, status: "already_sent", message: "Already sent today — not texting again." });
        } else {
          // Fresh approve → actually send through the sanctioned gated path.
          const res = await sendLeadSms({ id: leadId, body, userId: sms.userId, initials: sms.initials ?? null });
          if (res.disabled) {
            heldSms++;
            channels.push({ channel: "sms", approvalId: appr.id, status: "held", message: "SMS sending is off (SMS_SEND_ENABLED). Approved and recorded, but nothing was sent." });
          } else if (res.ok && res.duplicate) {
            duplicates++;
            channels.push({ channel: "sms", approvalId: appr.id, status: "already_sent", message: "That exact text was just sent — not sending again." });
          } else if (res.ok) {
            sentSms++;
            channels.push({ channel: "sms", approvalId: appr.id, status: "sent", message: "Text sent via Quo." });
          } else {
            failedSms++;
            channels.push({ channel: "sms", approvalId: appr.id, status: "failed", message: res.error ?? "Send failed." });
          }
        }
      }
    }

    rows.push({ leadId, clientName, channels, skipped: rowSkipped });
  }

  return { today, rows, queuedEmail, heldEmail, sentSms, failedSms, heldSms, duplicates, failed, skipped };
}
