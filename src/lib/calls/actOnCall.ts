// "Act on a call" — turn a finished Quo/OpenPhone call into proposed, approve-first actions.
//
// Flow (all triggered by a human asking Viktor "act on my last call with <X>"):
//   1. Resolve the call (the most recent one with a transcript, or one matched by contact name/number).
//   2. Link it to its Goodshuffle project by the caller's phone (getBookingByPhoneDigits), so email/note/
//      task actions have a target.
//   3. Reuse the EXISTING coaching recap (generateRecap) — executive summary, action items, a paste-ready
//      follow-up email, next step — as the interpreted content of the call.
//   4. Map that recap DETERMINISTICALLY into approval cards (send_email / append_note / create_gs_task /
//      send_sms), plus a quote-prep card when the call was about pricing.
//
// Governing law holds: RULES CALCULATE, AI INTERPRETS. The LLM only INTERPRETS the transcript (upstream, in
// generateRecap); the mapping here is deterministic, and nothing executes until a human approves. Money stays
// human-committed: a quote/pricing ask becomes a FORBIDDEN-to-execute `modify_quote` card that records intent
// and links into Goodshuffle for a person to finalize — it never changes a price on its own.

import {
  getRecentCallEvents,
  getCallEventById,
  getBookingByPhoneDigits,
  getCoachingAnalysis,
  type CallEventView,
  type BookingView,
} from "@/lib/db/repo";
import { generateRecap, type CallRecap } from "@/lib/coach/recap";
import {
  createApproval,
  approvalExistsByKey,
  type AiApproval,
  type ApprovalActionType,
  type ApprovalCard,
  type NewApproval,
} from "@/lib/aiorg/approvals";
import { getEmployee } from "@/lib/aiorg/registry";
import { botAnnounce, botForAgent, appUrl } from "@/lib/notify/aiBots";
import { humanize } from "@/lib/salesos/outreach";
import { withSmsSignoff, type TextTouch } from "@/lib/comms/smsSignoff";
import { signoffHistoryFor } from "@/lib/comms/smsSignoffHistory";
import { DISPLAY_TZ } from "@/lib/dates";

// The AI employee these proposals are attributed to. Maps to the Sales bot's Slack channel (aiBots.ts
// AGENT_TO_BOT), so post-call proposals announce where the sales team already watches.
export const ACT_ON_CALL_AGENT_ID = "sales-coach";
const AGENT_ID = ACT_ON_CALL_AGENT_ID;
const SMS_MAX = 320;
const MAX_TASKS = 3;

/** Last 10 digits of a phone, or null when there aren't enough digits to match a booking. */
export function digits10(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

/** Split a paste-ready "Subject: …\n\n<body>" draft into subject + body. PURE. */
export function parseEmailDraft(draft: string): { subject: string; body: string } {
  const text = (draft ?? "").trim();
  const m = text.match(/^subject:\s*(.+?)\s*(?:\n|$)/i);
  if (m) {
    const subject = m[1].trim();
    const body = text.slice(m[0].length).trim();
    return { subject: subject || "Following up on our call", body: body || text };
  }
  return { subject: "Following up on our call", body: text };
}

/** A short, house-style SMS distilled from the (customer-facing) follow-up email body. PURE-ish (humanize
 *  strips dashes/emoji per the comms house rule). Returns "" when there's nothing usable. */
export function smsFromEmail(emailBody: string): string {
  const firstName = ""; // caller fills a greeting; keep the distilled content neutral here
  void firstName;
  const body = (emailBody ?? "")
    .replace(/^subject:.*$/im, "")
    .replace(/^(hi|hello|hey|dear)\b.*$/im, "") // drop a greeting line; the caller adds one
    .replace(/\n{2,}/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!body) return "";
  const clipped = body.length > SMS_MAX ? body.slice(0, SMS_MAX - 1).replace(/\s+\S*$/, "") + "…" : body;
  return humanize(clipped);
}

/** True when the call was about a quote/price/estimate — so we offer a (human-finalized) quote-prep card. */
export function mentionsQuote(recap: CallRecap): boolean {
  const hay = [recap.executive, recap.nextStep, ...recap.keyPoints, ...recap.customerConcerns]
    .join(" ")
    .toLowerCase();
  return /\b(quote|pricing|price|estimate|proposal|revise|rev(?:ised|ise) the quote|discount)\b/.test(hay);
}

/** One proposed action, ready to become an approval card. `skipReason` set ⇒ not creatable (reported, not
 *  created), e.g. an email with no linked Goodshuffle project. */
export interface CallProposal {
  actionType: ApprovalActionType;
  title: string;
  payload: Record<string, unknown>;
  card: ApprovalCard;
  idempotencyKey: string;
  financial?: boolean;
  skipReason?: string;
}

function noteBody(recap: CallRecap, who: string): string {
  const lines: string[] = [`Call with ${who}.`];
  if (recap.executive) lines.push(recap.executive);
  if (recap.keyPoints.length) lines.push("Key points:", ...recap.keyPoints.map((k) => `• ${k}`));
  if (recap.customerConcerns.length) lines.push("Concerns:", ...recap.customerConcerns.map((c) => `• ${c}`));
  if (recap.nextStep) lines.push(`Next step: ${recap.nextStep}`);
  return lines.join("\n");
}

/** The customer's number for a call: the linked project's phone, else the call's own numbers. PURE. */
export function callCustomerPhone(call: CallEventView, booking: BookingView | null): string {
  return booking?.clientPhone?.trim() || call.fromPhone?.trim() || call.toPhone?.trim() || "";
}

/**
 * Map a call + its recap + the linked Goodshuffle booking into proposed approval cards. PURE (no DB, no LLM).
 * Deterministic: the same call/recap always yields the same proposals, and every six-field card is filled
 * from real recap facts — never invented. Actions needing a Goodshuffle target are reported as skipped (not
 * silently dropped) when the call isn't linked to a project.
 */
export function buildCallProposals(
  call: CallEventView,
  recap: CallRecap,
  booking: BookingView | null,
  opts: { textHistory?: TextTouch[] } = {},
): CallProposal[] {
  const out: CallProposal[] = [];
  const txId = booking?.bookingId ?? null;
  const who = booking?.clientName?.trim() || call.contactName?.trim() || "the customer";
  const phone = callCustomerPhone(call, booking);
  const dataUsed = `Call ${call.id}${call.occurredAt ? ` (${call.occurredAt})` : ""}; recap by ${recap.model ?? "the coaching model"}${txId ? `; Goodshuffle project ${txId}` : "; no linked Goodshuffle project"}.`;
  const base = (actionType: ApprovalActionType, extra: Partial<CallProposal> & Pick<CallProposal, "title" | "payload" | "card">): CallProposal => ({
    actionType,
    idempotencyKey: `act-on-call:${call.id}:${actionType}`,
    ...extra,
  });

  // 1) FOLLOW-UP EMAIL — the recap already drafted a paste-ready, customer-facing message.
  if (recap.followUpEmail.trim()) {
    const { subject, body } = parseEmailDraft(recap.followUpEmail);
    const clean = humanize(body);
    if (txId) {
      out.push(
        base("send_email", {
          title: `Follow-up email to ${who}`,
          payload: { transactionId: txId, subject, body: clean },
          card: {
            what: `Send a follow-up email to ${who} about the call.`,
            why: `${who} just finished a call; a timely, specific follow-up keeps it moving.`,
            dataUsed,
            expectedOutcome: "The customer gets the follow-up Viktor drafted from the call, in their Goodshuffle thread.",
            risk: "Low. The draft is reviewable and editable before it sends.",
            whatIfApproved: "Queues the email to the customer via Goodshuffle (gated by EMAIL_SEND_ENABLED).",
          },
        }),
      );
    } else {
      out.push(
        base("send_email", {
          title: `Follow-up email to ${who}`,
          payload: {},
          card: { what: "", why: "", dataUsed, expectedOutcome: "", risk: "", whatIfApproved: "" },
          skipReason: `Follow-up email drafted, but this call isn't linked to a Goodshuffle project (no matching client phone), so there's no thread to send into. Link the caller's number to the project and retry.`,
        }),
      );
    }
  }

  // 2) LOG A NOTE on the Goodshuffle project — the record of what was said/agreed.
  if (txId) {
    out.push(
      base("append_note", {
        title: `Log a call note on ${who}'s project`,
        payload: { transactionId: txId, body: noteBody(recap, who) },
        card: {
          what: `Log a note on ${who}'s Goodshuffle project summarizing the call.`,
          why: "Keeps the project's history accurate so anyone picking it up knows what was discussed.",
          dataUsed,
          expectedOutcome: "An internal note is added to the project with the call summary, key points, and next step.",
          risk: "Very low. Internal note only; nothing customer-facing.",
          whatIfApproved: "Appends the note to the Goodshuffle project.",
        },
      }),
    );
  } else {
    out.push({
      actionType: "append_note",
      title: `Log a call note for ${who}`,
      payload: {},
      card: { what: "", why: "", dataUsed, expectedOutcome: "", risk: "", whatIfApproved: "" },
      idempotencyKey: `act-on-call:${call.id}:append_note`,
      skipReason: "Call summary ready to log, but the call isn't linked to a Goodshuffle project (no matching client phone).",
    });
  }

  // 3) TASKS — the rep's own commitments from the call become tracked tasks (capped).
  if (txId) {
    recap.actionItems.slice(0, MAX_TASKS).forEach((item, i) => {
      const title = item.trim();
      if (!title) return;
      out.push({
        actionType: "create_gs_task",
        title: `Task: ${title}`,
        payload: { transactionId: txId, title, note: `From the call with ${who}.` },
        card: {
          what: `Create a task: "${title}".`,
          why: `A commitment made on the call with ${who}; tracking it so it doesn't slip.`,
          dataUsed,
          expectedOutcome: "A task is created on the Goodshuffle project.",
          risk: "Very low. Internal task only.",
          whatIfApproved: "Creates the task on the Goodshuffle project.",
        },
        idempotencyKey: `act-on-call:${call.id}:create_gs_task:${i}`,
      });
    });
  }

  // 4) FOLLOW-UP SMS — a short, house-style text distilled from the follow-up email. Held (delivers from the
  //    Sales panel), so this is a draft either way; only propose it when we have a number.
  //    It wraps up the call, so it carries the thank-you line unless the line already went to them today.
  const sms = recap.followUpEmail.trim() ? withSmsSignoff(smsFromEmail(recap.followUpEmail), { occasion: "start", history: opts.textHistory ?? [] }) : "";
  if (sms && phone) {
    out.push(
      base("send_sms", {
        title: `Follow-up text to ${who}`,
        payload: { phone, body: sms },
        card: {
          what: `Draft a follow-up text to ${who}.`,
          why: "A quick text can land faster than email for a short nudge.",
          dataUsed,
          expectedOutcome: "A short text draft is ready; a person sends it from the Sales panel.",
          risk: "Low. SMS is held, not auto-sent — approving records the decision; a human sends it.",
          whatIfApproved: "Records the decision. SMS delivers from the Sales lead panel (gated by SMS_SEND_ENABLED); it does not auto-send.",
        },
      }),
    );
  }

  // 5) QUOTE PREP — money stays human-committed. If the call was about a quote/price, record the intent and
  //    point to the project; a person finalizes the quote in Goodshuffle.
  if (txId && mentionsQuote(recap)) {
    out.push(
      base("modify_quote", {
        title: `Prepare a quote update for ${who}`,
        financial: true,
        payload: { transactionId: txId, note: recap.nextStep || "Quote or pricing came up on the call. Review and update it in Goodshuffle." },
        card: {
          what: `Prepare a quote/pricing update for ${who} based on the call.`,
          why: "The call touched pricing; capturing it so the quote reflects what was discussed.",
          dataUsed,
          expectedOutcome: "The intent is recorded. A person opens the project and finalizes the quote in Goodshuffle.",
          risk: "None automated. Quote/pricing changes are never executed by the AI; this only records intent.",
          whatIfApproved: "Records the decision only. Anything touching money is completed by a person in Goodshuffle (open the project to finalize).",
        },
      }),
    );
  }

  return out;
}

export interface ActOnCallResult {
  ok: boolean;
  callId?: string;
  contact?: string;
  /** Every card this run raised or found already raised. `isNew` is false when a re-run hit an existing
   *  card (idempotent), so callers can say "already waiting" instead of "created". */
  created: { id: string; actionType: string; title: string; isNew: boolean }[];
  skipped: string[];
  error?: string;
}

export interface ActOnCallOptions {
  callId?: string;
  contactQuery?: string;
  /** The human who asked (Slack user id or app user label). Named on the Slack note. */
  requestedBy?: string;
  /** How a card is raised. Defaults to createApproval; Viktor passes one that links each card to its
   *  session. Returning null means the card was refused (e.g. the session closed) and is reported skipped. */
  raise?: (input: NewApproval) => AiApproval | null;
}

/** Resolve which call to act on: an explicit id, else a contact-name/number match among recent calls, else
 *  the most recent call that has a transcript. Returns null when nothing matches. */
export function resolveRecentCall(opts: { callId?: string; contactQuery?: string }): CallEventView | null {
  if (opts.callId) return getCallEventById(opts.callId);
  const recent = getRecentCallEvents(50).filter((c) => (c.transcript ?? "").trim().length > 0);
  const q = opts.contactQuery?.toLowerCase().trim();
  if (q) {
    const qDigits = q.replace(/\D/g, "");
    return (
      recent.find((c) => {
        const name = (c.contactName ?? "").toLowerCase();
        if (name && name.includes(q)) return true;
        if (qDigits.length >= 4) {
          const cd = `${c.fromPhone ?? ""}${c.toPhone ?? ""}`.replace(/\D/g, "");
          if (cd.includes(qDigits)) return true;
        }
        return false;
      }) ?? null
    );
  }
  return recent[0] ?? null;
}

/** Link a call to its Goodshuffle booking by the caller's phone (tries both ends of the call). */
export function resolveBookingForCall(call: CallEventView): BookingView | null {
  for (const p of [call.fromPhone, call.toPhone]) {
    const d = digits10(p);
    if (!d) continue;
    const b = getBookingByPhoneDigits(d);
    if (b) return b;
  }
  return null;
}

/** "Inbound call, Nov 10, 2:05 PM" in the ops timezone. PURE. */
export function callLabel(call: Pick<CallEventView, "direction" | "occurredAt">): string {
  const dir = call.direction === "inbound" ? "Inbound call" : call.direction === "outbound" ? "Outbound call" : "Call";
  if (!call.occurredAt) return dir;
  const d = new Date(call.occurredAt);
  if (Number.isNaN(d.getTime())) return dir;
  const when = d.toLocaleString("en-US", { timeZone: DISPLAY_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${dir}, ${when}`;
}

/** How the asker shows in Slack: a Slack user id becomes a mention, anything else stays plain. PURE. */
export function askerLabel(who: string | undefined): string | null {
  const w = (who ?? "").trim();
  if (!w) return null;
  return /^[UW][A-Z0-9]{6,}$/.test(w) ? `<@${w}>` : w;
}

/**
 * Act on a finished call: resolve it, interpret it (reusing the cached recap or generating one), and raise
 * approve-first action cards. Idempotent (re-running the same call finds the same cards without
 * duplicating). Never executes anything itself: every card waits for a human approval. Never throws; a
 * failure comes back as a structured error.
 */
export async function actOnCall(opts: ActOnCallOptions): Promise<ActOnCallResult> {
  const call = resolveRecentCall(opts);
  if (!call) {
    return { ok: false, created: [], skipped: [], error: opts.contactQuery ? `No recent call found matching "${opts.contactQuery}".` : "No recent call with a transcript was found." };
  }
  if (!(call.transcript ?? "").trim()) {
    return { ok: false, callId: call.id, created: [], skipped: [], error: "That call has no transcript yet (Quo delivers it a few minutes after the call). Try again shortly." };
  }

  const booking = resolveBookingForCall(call);
  let recap = getCoachingAnalysis(call.id);
  if (!recap) {
    recap = await generateRecap({
      transcript: call.transcript ?? "",
      direction: call.direction,
      contactName: booking?.clientName ?? call.contactName,
      durationSec: call.durationSec,
      quoSummary: call.summary,
    });
  }
  if (!recap) {
    return { ok: false, callId: call.id, created: [], skipped: [], error: "Couldn't interpret the call (the transcript was too thin, or the LLM isn't configured)." };
  }

  // The human lead who owns the Sales Coach (the AI Org rollup groups approvals by this name).
  const owner = getEmployee(AGENT_ID)?.owner ?? "Sales";
  const raise = opts.raise ?? createApproval;
  const proposals = buildCallProposals(call, recap, booking, { textHistory: signoffHistoryFor(callCustomerPhone(call, booking)) });
  const created: ActOnCallResult["created"] = [];
  const skipped: string[] = [];
  for (const p of proposals) {
    if (p.skipReason) {
      skipped.push(p.skipReason);
      continue;
    }
    const isNew = !approvalExistsByKey(p.idempotencyKey);
    const a = raise({
      agentId: AGENT_ID,
      owner,
      title: p.title,
      actionType: p.actionType,
      actionPayload: p.payload,
      card: p.card,
      financial: p.financial,
      idempotencyKey: p.idempotencyKey,
    });
    if (!a) {
      skipped.push(`${p.title}: not raised (the session is closed).`);
      continue;
    }
    created.push({ id: a.id, actionType: a.actionType, title: a.title, isNew });
  }

  const contact = booking?.clientName ?? call.contactName ?? undefined;
  const fresh = created.filter((c) => c.isNew);
  // A bot never acts silently: announce NEW cards (a re-run that only found existing ones stays quiet).
  if (fresh.length) {
    const who = askerLabel(opts.requestedBy);
    void botAnnounce(botForAgent(AGENT_ID), {
      title: `Call follow up ready for approval${contact ? `: ${contact}` : ""}`,
      subtitle: who ? `Asked by ${who}` : undefined,
      fields: [
        { label: "Call", value: callLabel(call) },
        { label: "Cards", value: String(fresh.length) },
        { label: "Goodshuffle project", value: booking?.bookingId ?? "not linked" },
      ],
      body: fresh.map((c) => `• ${c.title}`).join("\n"),
      link: { text: "Review in AI Org", url: appUrl("/ai-org/approvals") },
      context: "Nothing sends until a person approves it. Quote and pricing changes are always finished by hand.",
    }).catch(() => {});
  }

  return { ok: true, callId: call.id, contact, created, skipped };
}
