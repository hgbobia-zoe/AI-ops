// Offline payment confirmation (owner rule, 2026-11-11; checks only and automatic since 2026-11-14). When a
// check clears, it is recorded in Goodshuffle, then receipt is confirmed to the customer by EMAIL (a
// Goodshuffle template) AND by TEXT. Goodshuffle confirms ACH payments itself, so ACH is never confirmed here. Checks: Lisa deposits; Lisa, Hermann or Cindy announce clearing. Full payment is
// due 7 days before the event.
//
// This file is the PURE core (no DB, no network): it reads Goodshuffle payment events, decides which ones
// are new offline payments worth confirming, and builds the approval card, the text, and the project note.
// The flow around it (src/lib/payments/offlineConfirmService.ts):
//   1. The fast pull notices a project's amount paid went up and asks the browser to read its payment
//      history (GET /app/vendorPayment/loadPaymentHistoryAndContractTotals).
//   2. Each new offline CHECK charge (paymentEvents[].offlinePayment === true, type "charge") raises ONE
//      card, idempotent per Goodshuffle payment id, approved at once by "Zoe automation"
//      (OFFLINE_PAYMENT_AUTO_SEND=false leaves it for a person).
//   3. On approve: the template email is queued to Goodshuffle, the text goes out through Quo, and a note
//      on the project records it and names who approved.
//
// Payment event shape (captured live 2026-11-11, read only): { id, type:"charge", offlinePayment:true,
// offline:{ paymentType:"CHECK", type:"Check" }, paymentMethodLabel:"Offline - Check", amount:<CENTS>,
// dateMillis, status:"Charged", processedBy:"<GS user full name>" }.
//
// RULES CALCULATE (no LLM). House style for customer text: no dashes, no emoji (humanize()).

import type { ApprovalCard } from "@/lib/aiorg/approvals";
import { humanize } from "@/lib/salesos/outreach";
import { initialsOf, salesOsNoteLine } from "@/lib/salesos/noteFormat";

/** The Goodshuffle email template that confirms a cleared offline payment (owner's pick, 2026-11-11).
 *  Its body reads "We have received your check payment for $ and appreciate your prompt payment", so the
 *  drainer fills the amount in after the bare "$". Overridable without a deploy. */
export const DEFAULT_TEMPLATE_NAME = "Payment Received – Balance Update Coming Soon";
export const DEFAULT_TEMPLATE_ID = "61182";
/** Only payments recorded at most this many days ago raise a card (older history is never confirmed). */
export const DEFAULT_LOOKBACK_DAYS = 21;
/** Full payment is due this many days before the event (owner rule). */
export const FINAL_PAYMENT_DAYS_BEFORE = 7;

export function templateName(env: Record<string, string | undefined> = process.env): string {
  return env.PAYMENT_CONFIRM_TEMPLATE?.trim() || DEFAULT_TEMPLATE_NAME;
}

/** The template id, only while the name is the default one (a renamed template is matched by name). */
export function templateId(env: Record<string, string | undefined> = process.env): string | null {
  const id = env.PAYMENT_CONFIRM_TEMPLATE_ID?.trim();
  if (id) return id;
  return env.PAYMENT_CONFIRM_TEMPLATE?.trim() ? null : DEFAULT_TEMPLATE_ID;
}

export function lookbackDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.OFFLINE_PAYMENT_LOOKBACK_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOOKBACK_DAYS;
}

// ── Payment events ───────────────────────────────────────────────────────────────────────────────────

/** One payment event as the pull sends it (a trimmed copy of Goodshuffle's paymentEvents[] entry). */
export interface InPaymentEvent {
  id?: string | number | null;
  type?: string | null;
  offlinePayment?: boolean | null;
  paymentType?: string | null; // offline.paymentType, e.g. "CHECK"
  label?: string | null; //       paymentMethodLabel, e.g. "Offline - Check"
  amount?: number | null; //      CENTS
  dateMillis?: number | null;
  status?: string | null;
  processedBy?: string | null;
}

export interface OfflinePayment {
  paymentId: string;
  amount: number; // dollars
  method: string; // "CHECK" | "ACH" | ... (upper case), "OTHER" when Goodshuffle gives none
  methodLabel: string; // as Goodshuffle shows it
  paidAt: string | null; // ISO
  recordedBy: string | null;
}

/** The offline charges in a project's payment history. Online card charges, authorizations, refunds and
 *  failed charges are ignored. PURE. */
export function offlineCharges(events: InPaymentEvent[] | null | undefined): OfflinePayment[] {
  const out: OfflinePayment[] = [];
  for (const e of events ?? []) {
    if (!e || e.offlinePayment !== true) continue;
    if ((e.type ?? "").toLowerCase() !== "charge") continue;
    const status = (e.status ?? "").toLowerCase();
    if (status && status !== "charged" && status !== "succeeded" && status !== "paid") continue;
    const id = e.id == null ? "" : String(e.id).trim();
    const cents = typeof e.amount === "number" && Number.isFinite(e.amount) ? e.amount : null;
    if (!id || cents == null || cents <= 0) continue;
    const label = (e.label ?? "").trim();
    const method = (e.paymentType ?? "").trim().toUpperCase() || methodFromLabel(label);
    out.push({
      paymentId: id,
      amount: Math.round(cents) / 100,
      method,
      methodLabel: label || "Offline",
      paidAt: typeof e.dateMillis === "number" && Number.isFinite(e.dateMillis) ? new Date(e.dateMillis).toISOString() : null,
      recordedBy: e.processedBy?.trim() || null,
    });
  }
  return out;
}

function methodFromLabel(label: string): string {
  const l = label.toLowerCase();
  if (/\bach\b|bank transfer|wire/.test(l)) return "ACH";
  if (/check|cheque/.test(l)) return "CHECK";
  if (/cash/.test(l)) return "CASH";
  return "OTHER";
}

/** How a method reads in a sentence to the customer: "check", "ACH", "bank", or "" (just "payment"). */
export function methodWord(method: string): string {
  switch (method.toUpperCase()) {
    case "CHECK":
      return "check";
    case "ACH":
      return "ACH";
    case "WIRE":
      return "wire";
    case "CASH":
      return "cash";
    default:
      return "";
  }
}

/** Is this payment recent enough to confirm? A payment with no date is treated as recent (it just
 *  appeared, which is why we looked). PURE. */
export function isRecent(paidAt: string | null, nowMs: number, days: number): boolean {
  if (!paidAt) return true;
  const t = Date.parse(paidAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t <= days * 86_400_000;
}

// ── Formatting ───────────────────────────────────────────────────────────────────────────────────────

/** "1,026.51" (no $), for filling the template's bare "$". PURE. */
export function amountDigits(dollars: number): string {
  return dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function usd(dollars: number): string {
  return `$${amountDigits(dollars)}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "December 12" from YYYY-MM-DD. PURE. */
export function longDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/** The final payment due date (event date minus 7 days), YYYY-MM-DD. PURE. */
export function finalPaymentDue(eventYmd: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eventYmd ?? "");
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - FINAL_PAYMENT_DAYS_BEFORE);
  return d.toISOString().slice(0, 10);
}

function firstName(name: string | null | undefined): string {
  const f = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return f && /[a-z]/i.test(f) ? f.charAt(0).toUpperCase() + f.slice(1) : "";
}

// ── What we confirm ──────────────────────────────────────────────────────────────────────────────────

export interface ConfirmContext {
  payment: OfflinePayment;
  bookingId: string;
  clientName: string;
  salesLead: string | null;
  eventDate: string | null; // YYYY-MM-DD
  /** Remaining balance after this payment (dollars), when Goodshuffle sent it. */
  remainingBalance: number | null;
  todayYmd: string;
  bank?: BankMatchSummary | null;
}

export interface BankMatchSummary {
  depositId: string;
  amount: number;
  postedAt: string | null;
  account: string | null;
  how: string; // "project number in the memo" | "matches the 50% deposit" | ...
}

/** The confirmation text, house style (no dashes, no emoji). Mentions the balance and its due date (full
 *  payment is due 7 days before the event), or that the project is paid in full. PURE. */
export function buildConfirmSms(c: ConfirmContext): string {
  const hi = firstName(c.clientName);
  const lead = firstName(c.salesLead);
  const who = lead ? `this is ${lead} from Zoe Events` : "this is the Zoe Events team";
  const word = methodWord(c.payment.method);
  const what = word ? `your ${word} payment of ${usd(c.payment.amount)}` : `your payment of ${usd(c.payment.amount)}`;
  const forEvent = c.eventDate ? ` for your ${longDate(c.eventDate)} event` : "";
  const parts = [`Hi${hi ? ` ${hi}` : ""}, ${who}. We received ${what}${forEvent} and it has cleared. Thank you!`];
  if (c.remainingBalance != null && c.remainingBalance > 0.009) {
    const due = finalPaymentDue(c.eventDate);
    if (due && due >= c.todayYmd) parts.push(`Your remaining balance of ${usd(c.remainingBalance)} is due by ${longDate(due)}.`);
    else parts.push(`Your remaining balance is ${usd(c.remainingBalance)}.`);
  } else if (c.remainingBalance != null) {
    parts.push("Your project is now paid in full.");
  }
  parts.push("You will also get a confirmation email.");
  return humanize(parts.join(" "));
}

function paidLabel(p: OfflinePayment): string {
  const word = methodWord(p.method);
  return word ? `${word} payment` : `${p.methodLabel.toLowerCase()} payment`;
}

function paidOn(p: OfflinePayment): string {
  return p.paidAt ? longDate(p.paidAt.slice(0, 10)) : "an unknown date";
}

/** The six-field approval card. Every field is filled from the real payment facts. PURE. */
export function buildConfirmCard(c: ConfirmContext, tplName: string): ApprovalCard {
  const p = c.payment;
  const who = c.clientName.trim() || "the customer";
  const recorded = p.recordedBy ? `${p.recordedBy} recorded` : "Someone recorded";
  const balance = c.remainingBalance == null ? "unknown" : usd(c.remainingBalance);
  const bank = c.bank
    ? `bank deposit of ${usd(c.bank.amount)}${c.bank.postedAt ? ` on ${longDate(c.bank.postedAt.slice(0, 10))}` : ""}${c.bank.account ? ` (${c.bank.account})` : ""} matched by ${c.bank.how}`
    : "no matching bank deposit seen yet";
  return {
    what: `Send ${who} the "${tplName}" email and a text confirming their ${paidLabel(p)} of ${usd(p.amount)} cleared.`,
    why: `${recorded} a ${p.methodLabel} payment of ${usd(p.amount)} on ${paidOn(p)} in Goodshuffle. Every cleared check is confirmed to the customer by email and text (Goodshuffle confirms ACH on its own).`,
    dataUsed: `Goodshuffle payment ${p.paymentId} (${p.methodLabel}, ${usd(p.amount)}, ${paidOn(p)}); project ${c.bookingId}; remaining balance ${balance}; ${bank}.`,
    expectedOutcome: "The customer gets the Goodshuffle template email with the amount filled in and a short text. A note on the project records both and who approved (Zoe automation when it sent on its own).",
    risk: c.bank
      ? "Low. Goes to the customer on file. Check the amount before approving."
      : "Low. Goes to the customer on file. No matching bank deposit was seen yet, so make sure the payment really cleared before approving.",
    whatIfApproved: "Queues the template email to Goodshuffle (EMAIL_SEND_ENABLED, sends on the next office sync), sends the text through Quo right away (SMS_SEND_ENABLED), and adds a Goodshuffle note naming you as the approver.",
  };
}

export function confirmTitle(c: Pick<ConfirmContext, "payment" | "clientName">): string {
  const word = methodWord(c.payment.method);
  return `Confirm ${word ? `${word} ` : ""}payment ${usd(c.payment.amount)}: ${c.clientName.trim() || "customer"}`;
}

/** The approval idempotency key: one card per Goodshuffle payment, forever. */
export function confirmKey(paymentId: string): string {
  return `offline-payment:${paymentId}`;
}

/** The internal note logged on the project after approval, in the team's note format. Names the approver
 *  and says honestly what happened to each send. PURE. */
export function buildConfirmNote(input: {
  approver: string;
  payment: Pick<OfflinePayment, "method" | "methodLabel" | "amount" | "paidAt" | "recordedBy">;
  tplName: string;
  emailQueued: boolean;
  smsOutcome: string; // "text sent" | "text not sent: <reason>"
  todayYmd: string;
}): string {
  const p = input.payment;
  const word = methodWord(p.method);
  const what = `${word ? `${word} ` : ""}payment of ${usd(p.amount)}${p.paidAt ? ` (${longDate(p.paidAt.slice(0, 10))})` : ""}${p.recordedBy ? `, recorded by ${p.recordedBy}` : ""}`;
  const email = input.emailQueued ? `email "${input.tplName}" queued` : "email not queued";
  const lead = input.approver === "Zoe automation" ? "Payment confirmation sent automatically" : `Payment confirmation approved by ${input.approver}`;
  const comment = `${lead}: ${what}. ${email}, ${input.smsOutcome}.`;
  return salesOsNoteLine(initialsOf(input.approver), humanize(comment), input.todayYmd);
}
