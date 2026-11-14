// Offline payment confirmation: the DB + side-effect half (the pure rules live in ./offlineConfirm.ts and
// ./bankDeposit.ts).
//
//   watchPaidIncreases   the pull saw a project's amount paid go up → put it on the watch list
//   paymentWatchIds      the fast pull asks which projects' payment histories to read
//   ingestPaymentHistories   the pull posts those histories → each NEW check payment is confirmed
//   afterConfirmApproved     approvals.ts calls this once the template email is queued → text + note
//   recordBankDeposit        the Zapier "Check Deposit" zap posts a deposit → stored + matched to a project
//
// Owner rules (2026-11-14): PHYSICAL CHECKS ONLY. Goodshuffle already confirms ACH payments to the customer
// on its own, so an ACH (or any non-check) payment is recorded as not_check and never confirmed here. A check
// confirmation comes from automation, so nobody approves it: the card is created as the audit record and
// approved at once by "Zoe automation", which queues the email, sends the text and logs the note. The Sales
// bot posts what went out.
//
// Kill switches: OFFLINE_PAYMENT_CONFIRM=false stops all of it. OFFLINE_PAYMENT_AUTO_SEND=false keeps the
// detection but goes back to an approve-first card for a person.

import { getDb } from "@/lib/db";
import { enqueueGsOp, gsNoteOpExists, getBookingById, insertAudit } from "@/lib/db/repo";
import { createApproval, approvalExistsByKey, getApproval, decideApproval } from "@/lib/aiorg/approvals";
import { botAnnounce, botForAgent, appUrl, type BotCard } from "@/lib/notify/aiBots";
import { sendLeadSms } from "@/lib/salesos/smsSend";
import { getOpenphoneUsers } from "@/lib/comms/openphone";
import { initialsOf } from "@/lib/salesos/noteFormat";
import { flagOn } from "@/lib/flags";
import { todayInOpsTz } from "@/lib/dates";
import {
  offlineCharges,
  isRecent,
  lookbackDays,
  templateName,
  templateId,
  amountDigits,
  usd,
  buildConfirmSms,
  buildConfirmCard,
  buildConfirmNote,
  confirmTitle,
  confirmKey,
  type InPaymentEvent,
  type OfflinePayment,
  type BankMatchSummary,
} from "./offlineConfirm";
import { normalizeDeposit, matchDeposit, projectNumbersIn, MATCH_LABEL, type DepositCandidate, type DepositMatch, type MatchKind } from "./bankDeposit";

export const OFFLINE_PAYMENT_CONFIRM_ENV = "OFFLINE_PAYMENT_CONFIRM";
export const OFFLINE_PAYMENT_AUTO_SEND_ENV = "OFFLINE_PAYMENT_AUTO_SEND";
/** Who approves an automatic confirmation (shows on the card, the note and the audit). */
export const AUTO_ACTOR = "Zoe automation";
/** The AI employee the cards belong to (Sales bot channel). The card's owner is the project's sales lead. */
export const CONFIRM_AGENT_ID = "outreach";
const WATCH_CAP = 25;
const WATCH_MAX_ATTEMPTS = 10;
const BANK_LOOKBACK_DAYS = 30; // a deposit up to 30 days before the payment was recorded can back it

export function offlineConfirmEnabled(): boolean {
  return flagOn(OFFLINE_PAYMENT_CONFIRM_ENV);
}

/** Check confirmations send on their own unless OFFLINE_PAYMENT_AUTO_SEND=false. */
export function offlineAutoSendEnabled(): boolean {
  return flagOn(OFFLINE_PAYMENT_AUTO_SEND_ENV);
}

/** Only a physical check is confirmed by us; Goodshuffle confirms ACH itself (owner, 2026-11-14). PURE. */
export function isCheckPayment(p: Pick<OfflinePayment, "method">): boolean {
  return p.method.toUpperCase() === "CHECK";
}

// ── Watch list ───────────────────────────────────────────────────────────────────────────────────────

/** Call BEFORE the bookings upsert: any project whose amount paid went up (vs the stored row) goes on the
 *  watch list. A project seen for the first time is skipped (no prior amount = no "went up"). */
export function watchPaidIncreases(records: { bookingId: string; amountPaid?: number | null }[]): number {
  if (!offlineConfirmEnabled()) return 0;
  const incoming = records.filter((r) => r.bookingId && typeof r.amountPaid === "number" && r.amountPaid > 0);
  if (incoming.length === 0) return 0;
  const db = getDb();
  const prior = new Map<string, number | null>();
  const CHUNK = 400;
  for (let i = 0; i < incoming.length; i += CHUNK) {
    const ids = incoming.slice(i, i + CHUNK).map((r) => r.bookingId);
    const rows = db.prepare(`SELECT booking_id, amount_paid FROM bookings WHERE booking_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { booking_id: string; amount_paid: number | null }[];
    for (const r of rows) prior.set(r.booking_id, r.amount_paid);
  }
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO gs_payment_watch (booking_id, requested_at, attempts, done_at) VALUES (?, ?, 0, NULL)
     ON CONFLICT(booking_id) DO UPDATE SET requested_at = excluded.requested_at, attempts = 0, done_at = NULL`,
  );
  let n = 0;
  for (const r of incoming) {
    if (!prior.has(r.bookingId)) continue;
    const before = prior.get(r.bookingId) ?? 0;
    if ((r.amountPaid as number) > (before ?? 0) + 0.009) {
      upsert.run(r.bookingId, now);
      n++;
    }
  }
  return n;
}

/** Put one project on the watch list by hand (testing on a sandbox project, or a re-check). */
export function watchBooking(bookingId: string): void {
  getDb()
    .prepare(
      `INSERT INTO gs_payment_watch (booking_id, requested_at, attempts, done_at) VALUES (?, ?, 0, NULL)
       ON CONFLICT(booking_id) DO UPDATE SET requested_at = excluded.requested_at, attempts = 0, done_at = NULL`,
    )
    .run(bookingId, new Date().toISOString());
}

/** The projects whose payment history the fast pull should read now. Each hand-out counts an attempt, so
 *  a drainer that never posts back (an old extension) cannot keep one on the list forever. */
export function paymentWatchIds(cap = WATCH_CAP): string[] {
  if (!offlineConfirmEnabled()) return [];
  const db = getDb();
  const ids = (
    db.prepare(`SELECT booking_id FROM gs_payment_watch WHERE done_at IS NULL AND attempts < ? ORDER BY requested_at LIMIT ?`).all(WATCH_MAX_ATTEMPTS, cap) as { booking_id: string }[]
  ).map((r) => r.booking_id);
  if (ids.length) db.prepare(`UPDATE gs_payment_watch SET attempts = attempts + 1 WHERE booking_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  return ids;
}

// ── Ingest ───────────────────────────────────────────────────────────────────────────────────────────

export interface InPaymentHistory {
  bookingId?: string | number | null;
  ok?: boolean;
  grandTotalCents?: number | null; // loadPaymentHistoryAndContractTotals.grandTotal
  paidCents?: number | null; //       paymentHistory.totalContractApplicablePaid
  events?: InPaymentEvent[] | null;
}

/** Balance left after the payments so far, in dollars (total minus paid, never below 0). Goodshuffle's own
 *  remainingBalance nets out card pre-authorizations, so it can read 0 on an unpaid project. PURE. */
export function remainingFrom(h: Pick<InPaymentHistory, "grandTotalCents" | "paidCents">): number | null {
  const t = h.grandTotalCents, p = h.paidCents;
  if (typeof t !== "number" || !Number.isFinite(t) || typeof p !== "number" || !Number.isFinite(p)) return null;
  return Math.max(0, Math.round(t - p)) / 100;
}

export interface IngestResult {
  histories: number;
  offlineSeen: number;
  newPayments: number;
  cardsRaised: number;
  skipped: { paymentId: string; reason: string }[];
  /** Check confirmations approved by automation in this ingest, with the approve outcome. */
  autoSent: { paymentId: string; outcome: string }[];
}

interface PaymentRow {
  payment_id: string;
  booking_id: string;
  amount: number;
  method: string | null;
  method_label: string | null;
  recorded_by: string | null;
  paid_at: string | null;
  remaining_balance: number | null;
  state: string;
  approval_id: string | null;
  bank_deposit_id: string | null;
  approved_by: string | null;
  sms_status: string | null;
}

function getPaymentRow(paymentId: string): PaymentRow | null {
  return (getDb().prepare("SELECT * FROM gs_offline_payments WHERE payment_id = ?").get(paymentId) as PaymentRow | undefined) ?? null;
}

/** Store the payment histories the pull read. Every offline charge is recorded once (by Goodshuffle payment
 *  id). A NEW check recorded inside the look-back is confirmed: sent at once by automation, or an
 *  approve-first card when OFFLINE_PAYMENT_AUTO_SEND=false. ACH and other non-check payments are recorded as
 *  not_check, older history as too_old; neither is ever confirmed. Idempotent: re-posting changes nothing. */
export function ingestPaymentHistories(items: InPaymentHistory[], nowMs = Date.now()): IngestResult {
  const db = getDb();
  const res: IngestResult = { histories: 0, offlineSeen: 0, newPayments: 0, cardsRaised: 0, skipped: [], autoSent: [] };
  const enabled = offlineConfirmEnabled();
  const days = lookbackDays();
  const nowIso = new Date(nowMs).toISOString();
  const auto = offlineAutoSendEnabled();
  const fresh: Raised[] = [];
  for (const h of items) {
    const bookingId = h.bookingId == null ? "" : String(h.bookingId).trim();
    if (!bookingId) continue;
    if (h.ok === false) continue; // a failed read: leave the watch open (attempts already counted)
    res.histories++;
    db.prepare("UPDATE gs_payment_watch SET done_at = ? WHERE booking_id = ?").run(nowIso, bookingId);
    const remaining = remainingFrom(h);
    for (const p of offlineCharges(h.events)) {
      res.offlineSeen++;
      if (getPaymentRow(p.paymentId)) continue;
      res.newPayments++;
      const booking = getBookingById(bookingId);
      let state = "proposed";
      if (!booking) state = "no_booking";
      else if (!enabled) state = "disabled";
      else if (!isCheckPayment(p)) state = "not_check";
      else if (!isRecent(p.paidAt, nowMs, days)) state = "too_old";
      db.prepare(
        `INSERT OR IGNORE INTO gs_offline_payments (payment_id, booking_id, amount, method, method_label, recorded_by, paid_at, remaining_balance, state, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(p.paymentId, bookingId, p.amount, p.method, p.methodLabel, p.recordedBy, p.paidAt, remaining, state, nowIso);
      if (state !== "proposed" || !booking) {
        res.skipped.push({ paymentId: p.paymentId, reason: state });
        continue;
      }
      const raised = raiseConfirmCard(p, bookingId, remaining, nowMs);
      if (raised) {
        res.cardsRaised++;
        fresh.push(raised);
      }
    }
  }
  if (fresh.length && auto) {
    for (const f of fresh) {
      const r = autoConfirm(f.approvalId);
      res.autoSent.push({ paymentId: f.paymentId, outcome: r.outcome });
      void botAnnounce(botForAgent(CONFIRM_AGENT_ID), autoRecordCard(f, r, templateName())).catch(() => {});
    }
  } else if (fresh.length) {
    void botAnnounce(botForAgent(CONFIRM_AGENT_ID), {
      title: fresh.length === 1 ? "Check payment to confirm" : `${fresh.length} check payments to confirm`,
      fields: fresh.slice(0, 6).map((f) => ({ label: f.owner, value: f.title })),
      body: "A check payment was recorded in Goodshuffle. Approve to send the customer the payment email and a text.",
      link: { text: "Review in AI Org", url: appUrl("/ai-org/approvals") },
      context: "Automatic sending is off (OFFLINE_PAYMENT_AUTO_SEND=false), so nothing sends until a person approves it.",
    }).catch(() => {});
  }
  return res;
}

interface Raised {
  title: string;
  owner: string;
  bookingId: string;
  approvalId: string;
  paymentId: string;
  text: string;
}

/** Approve a just raised check confirmation as automation: the same path a person's approve takes (email
 *  queued behind EMAIL_SEND_ENABLED, then the text and the note in afterConfirmApproved). Never throws. */
function autoConfirm(approvalId: string): { outcome: string; message: string } {
  try {
    const d = decideApproval(approvalId, "approve", AUTO_ACTOR, { note: "Sent automatically (check payment).", announce: false });
    return { outcome: d.outcome, message: d.message };
  } catch (e) {
    return { outcome: "failed", message: e instanceof Error ? e.message : "approve failed" };
  }
}

/** The Slack record of an automatic confirmation: what went to the customer, or why it did not. PURE. */
export function autoRecordCard(f: Pick<Raised, "title" | "owner" | "bookingId" | "text">, r: { outcome: string; message: string }, tplName: string): BotCard {
  const queued = r.outcome === "executed_queued";
  return {
    emoji: queued ? "✅" : "⚠️",
    title: queued ? "Check payment confirmed to the customer" : "Check payment confirmation held",
    fields: [
      { label: "Payment", value: f.title },
      { label: "Sales lead", value: f.owner },
      { label: "Email", value: queued ? `"${tplName}", goes out on the next Goodshuffle sync` : "not sent" },
      { label: "Text", value: queued ? "sending now through Quo" : "not sent" },
    ],
    sections: f.text ? [`>${f.text.replace(/\n/g, "\n>")}`] : undefined,
    body: queued ? "Sent automatically, nobody needed to approve it." : `Nothing went to the customer: ${r.message}`,
    link: { text: "Open the lead", url: appUrl(`/salesos/${encodeURIComponent(f.bookingId)}`) },
    context: "OFFLINE_PAYMENT_AUTO_SEND=false goes back to approve first",
  };
}

/** A matched bank deposit for this payment (same amount, same project, posted up to 30 days before it was
 *  recorded or a few days after). Newest first. */
export function bankMatchFor(bookingId: string, amount: number, paidAt: string | null): BankMatchSummary | null {
  const anchor = paidAt ? Date.parse(paidAt) : Date.now();
  const from = new Date(anchor - BANK_LOOKBACK_DAYS * 86_400_000).toISOString();
  const to = new Date(anchor + 10 * 86_400_000).toISOString();
  const r = getDb()
    .prepare(
      `SELECT deposit_id, amount, posted_at, account, match_kind FROM bank_deposits
       WHERE booking_id = ? AND ABS(amount - ?) < 0.005 AND (posted_at IS NULL OR (posted_at >= ? AND posted_at <= ?))
       ORDER BY COALESCE(posted_at, received_at) DESC LIMIT 1`,
    )
    .get(bookingId, amount, from, to) as { deposit_id: string; amount: number; posted_at: string | null; account: string | null; match_kind: string } | undefined;
  if (!r) return null;
  return { depositId: r.deposit_id, amount: r.amount, postedAt: r.posted_at, account: r.account, how: MATCH_LABEL[r.match_kind as MatchKind] ?? r.match_kind };
}

function raiseConfirmCard(p: OfflinePayment, bookingId: string, remaining: number | null, nowMs: number): Raised | null {
  const b = getBookingById(bookingId);
  if (!b) return null;
  const key = confirmKey(p.paymentId);
  if (approvalExistsByKey(key)) return null;
  const tpl = templateName();
  const bank = bankMatchFor(bookingId, p.amount, p.paidAt);
  const ctx = { payment: p, bookingId, clientName: b.clientName, salesLead: b.salesLead ?? null, eventDate: b.eventDate, remainingBalance: remaining, todayYmd: todayInOpsTz(new Date(nowMs)), bank };
  const owner = b.salesLead?.trim() || "Sales";
  const title = confirmTitle(ctx);
  const text = buildConfirmSms(ctx);
  const a = createApproval({
    agentId: CONFIRM_AGENT_ID,
    owner,
    title,
    actionType: "confirm_payment",
    actionPayload: {
      transactionId: bookingId,
      leadId: bookingId,
      paymentId: p.paymentId,
      templateName: tpl,
      templateId: templateId(),
      fillAmount: amountDigits(p.amount),
      // A same-subject email sent after this payment was seen means someone already confirmed by hand.
      sentAfter: new Date(nowMs).toISOString(),
      dedupeKey: key,
      body: text, // the text; editable on the card
    },
    card: buildConfirmCard(ctx, tpl),
    idempotencyKey: key,
  });
  getDb().prepare("UPDATE gs_offline_payments SET approval_id = ?, bank_deposit_id = ? WHERE payment_id = ?").run(a.id, bank?.depositId ?? null, p.paymentId);
  return { title, owner, bookingId, approvalId: a.id, paymentId: p.paymentId, text };
}

// ── After approve ────────────────────────────────────────────────────────────────────────────────────

async function quoUserIdFor(name: string | null | undefined): Promise<string | undefined> {
  const want = (name ?? "").trim().toLowerCase().split(/\s+/)[0];
  if (!want) return undefined;
  const users = await getOpenphoneUsers().catch(() => []);
  return users.find((u) => u.name.trim().toLowerCase().split(/\s+/)[0] === want)?.id;
}

/** Runs once the confirmation email is queued: send the text through Quo (as the sales lead's line when
 *  Quo knows them, else the main line), then log the project note naming the approver. Idempotent: a
 *  payment whose text was already handled is not texted again. Never throws. */
export async function afterConfirmApproved(approvalId: string, actor: string): Promise<{ sms: string; noteQueued: boolean } | null> {
  const a = getApproval(approvalId);
  if (!a || a.actionType !== "confirm_payment") return null;
  const paymentId = typeof a.actionPayload.paymentId === "string" ? a.actionPayload.paymentId : "";
  const row = paymentId ? getPaymentRow(paymentId) : null;
  if (!row) return null;
  if (row.sms_status) return { sms: row.sms_status, noteQueued: !!row.approved_by };
  const db = getDb();
  const now = new Date().toISOString();
  // Claim first, so a double approve path can never text twice.
  const claimed = db.prepare("UPDATE gs_offline_payments SET sms_status = 'sending', approved_by = ?, approved_at = ? WHERE payment_id = ? AND sms_status IS NULL").run(actor, now, paymentId);
  if (claimed.changes === 0) return null;

  const booking = getBookingById(row.booking_id);
  const body = typeof a.actionPayload.body === "string" ? a.actionPayload.body.trim() : "";
  let smsStatus = "skipped";
  let smsDetail = "";
  if (!body) smsDetail = "no text on the card";
  else {
    try {
      // A payment receipt is an operational text: the sales thank-you line ("Thank you for considering us for
      // your event.") never goes on it (owner rule, smsSignoff.ts). "reply" is the occasion that never adds it.
      const r = await sendLeadSms({ id: row.booking_id, body, userId: await quoUserIdFor(booking?.salesLead), initials: initialsOf(actor), occasion: "reply" });
      if (r.ok) smsStatus = "sent";
      else if (r.disabled) {
        smsStatus = "held";
        smsDetail = "SMS sending is off";
      } else {
        smsStatus = "failed";
        smsDetail = r.error ?? "send failed";
      }
    } catch (e) {
      smsStatus = "failed";
      smsDetail = e instanceof Error ? e.message : "send failed";
    }
  }
  const smsOutcome = smsStatus === "sent" ? "text sent" : `text not sent: ${smsDetail || smsStatus}`;

  const noteKey = `offline-payment-note:${paymentId}`;
  let noteOpId: string | null = null;
  if (!gsNoteOpExists(noteKey)) {
    const line = buildConfirmNote({
      approver: actor,
      payment: { method: row.method ?? "OTHER", methodLabel: row.method_label ?? "Offline", amount: row.amount, paidAt: row.paid_at, recordedBy: row.recorded_by },
      tplName: typeof a.actionPayload.templateName === "string" ? a.actionPayload.templateName : templateName(),
      emailQueued: !!a.outboxOpId,
      smsOutcome,
      todayYmd: todayInOpsTz(),
    });
    try {
      noteOpId = enqueueGsOp({ op: "note_append", transactionId: row.booking_id, label: `Payment confirmation note (${usd(row.amount)})`, payload: { line, dedupeKey: noteKey } }).id;
    } catch (e) {
      console.error("[offlineConfirm] note enqueue failed", e);
    }
  }
  db.prepare("UPDATE gs_offline_payments SET sms_status = ?, sms_detail = ?, note_op_id = ? WHERE payment_id = ?").run(smsStatus, smsDetail || null, noteOpId, paymentId);
  try {
    insertAudit({ actor, action: "PAYMENT_CONFIRMATION_SENT", entity: "gs_offline_payment", entityId: paymentId, after: { bookingId: row.booking_id, approvalId, emailOp: a.outboxOpId, sms: smsStatus, smsDetail: smsDetail || null, noteOp: noteOpId } });
  } catch {
    /* audit is best effort */
  }
  if (smsStatus !== "sent") {
    void botAnnounce(botForAgent(CONFIRM_AGENT_ID), {
      title: "Payment confirmation text did not go out",
      fields: [
        { label: "Item", value: a.title },
        { label: "Approved by", value: actor },
        { label: "Why", value: smsDetail || smsStatus },
      ],
      body: "The email is queued. Send the text by hand from the Sales lead panel.",
      link: { text: "Open the lead", url: appUrl(`/salesos/${encodeURIComponent(row.booking_id)}`) },
    }).catch(() => {});
  }
  return { sms: smsStatus, noteQueued: !!noteOpId };
}

// ── Bank deposits ────────────────────────────────────────────────────────────────────────────────────

export interface BankDepositResult {
  ok: boolean;
  ignored?: string;
  duplicate?: boolean;
  depositId?: string;
  match?: DepositMatch;
}

/** True when the request carries the configured token (or none is configured yet). */
export function bankTokenOk(headers: Headers, env: Record<string, string | undefined> = process.env): boolean {
  const bank = env.BANK_WEBHOOK_TOKEN?.trim();
  if (bank) return headers.get("x-bank-token") === bank;
  const wire = env.WIRE_WEBHOOK_TOKEN?.trim();
  if (wire) return headers.get("x-wire-token") === wire || headers.get("x-bank-token") === wire;
  return true;
}

/** Optional account filter: BANK_DEPOSIT_ACCOUNT (a case-insensitive pattern) ignores deposits from other
 *  accounts when the zap sends an account name. Unset = accept every deposit the zap sends. */
function accountAllowed(account: string | null): boolean {
  const pat = process.env.BANK_DEPOSIT_ACCOUNT?.trim();
  if (!pat || !account) return true;
  try {
    return new RegExp(pat, "i").test(account);
  } catch {
    return account.toLowerCase().includes(pat.toLowerCase());
  }
}

/** Store one deposit from the "Check Deposit" zap and match it to a project. Idempotent on the bank
 *  transaction id (a re-delivery returns the stored match). Money out and zero amounts are ignored. */
export function recordBankDeposit(raw: unknown, nowMs = Date.now()): BankDepositResult {
  const d = normalizeDeposit(raw);
  if (d.amount == null) return { ok: false, ignored: "no amount" };
  if (d.amount <= 0) return { ok: true, ignored: "not a deposit" };
  if (d.status && /fail|cancel|reversed|returned/.test(d.status)) return { ok: true, ignored: `status ${d.status}` };
  if (!accountAllowed(d.account)) return { ok: true, ignored: "other account" };
  const depositId = d.depositId ?? `amt:${d.amount.toFixed(2)}:${d.postedAt ?? "nodate"}`;
  const db = getDb();
  const existing = db.prepare("SELECT booking_id, match_kind, match_note FROM bank_deposits WHERE deposit_id = ?").get(depositId) as
    | { booking_id: string | null; match_kind: string; match_note: string }
    | undefined;
  if (existing) return { ok: true, duplicate: true, depositId, match: { bookingId: existing.booking_id, kind: existing.match_kind as DepositMatch["kind"], note: existing.match_note } };

  const nums = projectNumbersIn(d.description);
  const known = new Set<string>(
    nums.length ? (db.prepare(`SELECT booking_id FROM bookings WHERE booking_id IN (${nums.map(() => "?").join(",")})`).all(...nums) as { booking_id: string }[]).map((r) => r.booking_id) : [],
  );
  const since = new Date(nowMs - BANK_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const candidates = (
    db
      .prepare(`SELECT booking_id, signed, archived, event_date, grand_total, amount_due FROM bookings WHERE signed = 1 AND COALESCE(archived,0) = 0 AND (event_date IS NULL OR event_date >= ?)`)
      .all(since) as { booking_id: string; signed: number; archived: number | null; event_date: string | null; grand_total: number | null; amount_due: number | null }[]
  ).map(
    (r): DepositCandidate => ({ bookingId: r.booking_id, signed: r.signed === 1, archived: r.archived === 1, eventDate: r.event_date, grandTotal: r.grand_total, amountDue: r.amount_due }),
  );
  const match = matchDeposit(d, known, candidates);
  db.prepare(
    `INSERT OR IGNORE INTO bank_deposits (deposit_id, amount, posted_at, description, account, booking_id, match_kind, match_note, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(depositId, d.amount, d.postedAt, d.description || null, d.account, match.bookingId, match.kind, match.note, new Date(nowMs).toISOString());
  return { ok: true, depositId, match };
}
