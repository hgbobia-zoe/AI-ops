import { beforeEach, describe, expect, it, vi } from "vitest";

const texts: { id: string; body: string; userId?: string; initials?: string | null; occasion?: string }[] = [];
vi.mock("@/lib/salesos/smsSend", () => ({
  sendLeadSms: async (input: { id: string; body: string; userId?: string; initials?: string | null; occasion?: string }) => {
    texts.push(input);
    return { ok: true, providerMsgId: `m-${texts.length}` };
  },
}));
vi.mock("@/lib/comms/openphone", () => ({ getOpenphoneUsers: async () => [{ id: "US-JESSIE", name: "Jessie Medalla" }] }));
const announced: unknown[] = [];
vi.mock("@/lib/notify/aiBots", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify/aiBots")>()),
  botAnnounce: async (_bot: unknown, card: unknown) => {
    announced.push(card);
    return { ok: true };
  },
}));

import { getDb } from "@/lib/db";
import { saveBookings, listPendingGsOps, type BookingRecord } from "@/lib/db/repo";
import { decideApproval, getApproval, listPendingApprovals } from "@/lib/aiorg/approvals";
import {
  watchPaidIncreases,
  paymentWatchIds,
  ingestPaymentHistories,
  afterConfirmApproved,
  recordBankDeposit,
  remainingFrom,
  bankTokenOk,
} from "./offlineConfirmService";

const NOW = Date.parse("2026-11-11T16:00:00Z");
const TX = "231812125"; // TEST 3 (sandbox)

const booking = (id: string, over: Partial<BookingRecord> = {}): BookingRecord => ({
  bookingId: id,
  eventName: `TEST ${id}`,
  eventDate: "2026-12-12",
  statusLabel: "Contract Signed",
  signed: true,
  grandTotal: 2053.01,
  amountPaid: 0,
  amountDue: 2053.01,
  clientName: "Hermann Gbobia",
  clientEmail: "test@example.com",
  clientPhone: "3015550100",
  salesLead: "Jessie Medalla",
  ...over,
});

const charge = (id: number, cents: number, when: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "charge",
  offlinePayment: true,
  paymentType: "CHECK",
  label: "Offline - Check",
  amount: cents,
  dateMillis: Date.parse(when),
  status: "Charged",
  processedBy: "Cindy Gbobia",
  ...over,
});

const ops = (op: string) => listPendingGsOps().filter((o) => o.op === op && o.transactionId === TX);
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  const db = getDb();
  for (const t of ["bookings", "gs_payment_watch", "gs_offline_payments", "bank_deposits", "ai_approvals", "gs_outbox"]) db.prepare(`DELETE FROM ${t}`).run();
  texts.length = 0;
  announced.length = 0;
});

describe("watch list", () => {
  it("watches a project only when its amount paid went up vs the stored row", () => {
    saveBookings([booking(TX), booking("B2", { amountPaid: 300 })]);
    expect(watchPaidIncreases([{ bookingId: TX, amountPaid: 1026.51 }, { bookingId: "B2", amountPaid: 300 }, { bookingId: "NEW", amountPaid: 50 }])).toBe(1);
    expect(paymentWatchIds()).toEqual([TX]);
  });

  it("stops handing out a watch the pull never answers", () => {
    saveBookings([booking(TX)]);
    watchPaidIncreases([{ bookingId: TX, amountPaid: 10 }]);
    for (let i = 0; i < 10; i++) expect(paymentWatchIds()).toEqual([TX]);
    expect(paymentWatchIds()).toEqual([]);
  });
});

describe("ingest → card → approve → email + text + note", () => {
  it("with automatic sending off, raises one card per new check and runs the follow up on approve", async () => {
    vi.stubEnv("OFFLINE_PAYMENT_AUTO_SEND", "false");
    saveBookings([booking(TX)]);
    watchPaidIncreases([{ bookingId: TX, amountPaid: 1026.51 }]);
    const history = { bookingId: TX, ok: true, grandTotalCents: 205301, paidCents: 102651, events: [charge(1143998117, 102651, "2026-11-10T05:00:00Z")] };
    const r = ingestPaymentHistories([history], NOW);
    expect(r).toMatchObject({ histories: 1, offlineSeen: 1, newPayments: 1, cardsRaised: 1 });
    expect(paymentWatchIds()).toEqual([]); // the watch closed
    expect(announced).toHaveLength(1);

    // Idempotent: posting the same history again changes nothing.
    expect(ingestPaymentHistories([history], NOW)).toMatchObject({ newPayments: 0, cardsRaised: 0 });

    const [card] = listPendingApprovals().filter((a) => a.actionType === "confirm_payment");
    expect(card.owner).toBe("Jessie Medalla");
    expect(card.actionPayload).toMatchObject({ transactionId: TX, paymentId: "1143998117", templateId: "61182", fillAmount: "1,026.51" });
    expect(String(card.actionPayload.body)).toContain("Your remaining balance of $1,026.50 is due by December 5.");

    // An edit on the card changes only the text; the payment ids survive.
    decideApproval(card.id, "edit", "Hermann Gbobia", { editedPayload: { transactionId: TX, body: "Hi Hermann, your check cleared. Thank you!", subject: "" } });
    expect(getApproval(card.id)!.actionPayload).toMatchObject({ paymentId: "1143998117", fillAmount: "1,026.51", body: "Hi Hermann, your check cleared. Thank you!" });

    const dec = decideApproval(card.id, "approve", "Hermann Gbobia");
    expect(dec.outcome).toBe("executed_queued");
    const [email] = ops("email_template");
    expect(email.payload).toMatchObject({ templateId: "61182", fillAmount: "1,026.51", dedupeKey: "offline-payment:1143998117" });
    expect(typeof (email.payload as { sentAfter?: string }).sentAfter).toBe("string");

    // approvals.ts fires the follow up; calling it again must not text twice.
    await tick();
    await afterConfirmApproved(card.id, "Hermann Gbobia");
    expect(texts).toEqual([{ id: TX, body: "Hi Hermann, your check cleared. Thank you!", userId: "US-JESSIE", initials: "HG", occasion: "reply" }]);
    const notes = ops("note_append");
    expect(notes).toHaveLength(1);
    const line = String((notes[0].payload as { line: string }).line);
    expect(line).toContain("approved by Hermann Gbobia");
    expect(line).toContain("text sent");
    const row = getDb().prepare("SELECT state, approved_by, sms_status FROM gs_offline_payments WHERE payment_id = ?").get("1143998117");
    expect(row).toEqual({ state: "proposed", approved_by: "Hermann Gbobia", sms_status: "sent" });
    vi.unstubAllEnvs();
  });

  it("sends a check confirmation on its own: email queued, text sent, note and Slack record", async () => {
    saveBookings([booking(TX)]);
    const history = { bookingId: TX, ok: true, grandTotalCents: 205301, paidCents: 102651, events: [charge(1143998117, 102651, "2026-11-10T05:00:00Z")] };
    const r = ingestPaymentHistories([history], NOW);
    expect(r).toMatchObject({ newPayments: 1, cardsRaised: 1, autoSent: [{ paymentId: "1143998117", outcome: "executed_queued" }] });
    expect(listPendingApprovals().filter((a) => a.actionType === "confirm_payment")).toHaveLength(0); // nobody has to approve
    const [email] = ops("email_template");
    expect(email.payload).toMatchObject({ templateId: "61182", fillAmount: "1,026.51", dedupeKey: "offline-payment:1143998117" });
    await tick();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ id: TX, userId: "US-JESSIE", occasion: "reply" });
    expect(texts[0].body).toContain("We received your check payment of $1,026.51");
    const line = String((ops("note_append")[0].payload as { line: string }).line);
    expect(line).toContain("Payment confirmation sent automatically");
    expect(line).toContain("text sent");
    // One Slack record per payment that says what went out (the generic "Approved" post is skipped).
    expect(announced).toHaveLength(1);
    const rec = announced[0] as { title: string; sections?: string[]; fields: { label: string; value: string }[] };
    expect(rec.title).toBe("Check payment confirmed to the customer");
    expect(rec.sections?.[0]).toContain("We received your check payment of $1,026.51");
    expect(rec.fields.find((f) => f.label === "Sales lead")?.value).toBe("Jessie Medalla");
    // Re-posting the history never sends again.
    expect(ingestPaymentHistories([history], NOW)).toMatchObject({ newPayments: 0, autoSent: [] });
    await tick();
    expect(texts).toHaveLength(1);
  });

  it("never confirms an ACH payment: Goodshuffle already does", async () => {
    saveBookings([booking(TX)]);
    const ach = charge(77, 50000, "2026-11-10T05:00:00Z", { paymentType: "ACH", label: "Offline - ACH" });
    const r = ingestPaymentHistories([{ bookingId: TX, ok: true, events: [ach] }], NOW);
    expect(r).toMatchObject({ newPayments: 1, cardsRaised: 0, autoSent: [], skipped: [{ paymentId: "77", reason: "not_check" }] });
    await tick();
    expect(texts).toHaveLength(0);
    expect(ops("email_template")).toHaveLength(0);
    expect(announced).toHaveLength(0);
    const row = getDb().prepare("SELECT state FROM gs_offline_payments WHERE payment_id = '77'").get();
    expect(row).toEqual({ state: "not_check" });
  });

  it("holds the send, and says so in Slack, while the email gate is off", async () => {
    vi.stubEnv("EMAIL_SEND_ENABLED", "false");
    try {
      saveBookings([booking(TX)]);
      const r = ingestPaymentHistories([{ bookingId: TX, ok: true, events: [charge(88, 1000, "2026-11-10T05:00:00Z")] }], NOW);
      expect(r.autoSent).toEqual([{ paymentId: "88", outcome: "held_gate_off" }]);
      await tick();
      expect(texts).toHaveLength(0);
      expect((announced[0] as { title: string }).title).toBe("Check payment confirmation held");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("records old offline history without raising a card", () => {
    saveBookings([booking(TX)]);
    const r = ingestPaymentHistories([{ bookingId: TX, ok: true, events: [charge(5, 50000, "2025-12-02T05:00:00Z")] }], NOW);
    expect(r).toMatchObject({ newPayments: 1, cardsRaised: 0, skipped: [{ paymentId: "5", reason: "too_old" }] });
    expect(listPendingApprovals()).toHaveLength(0);
  });

  it("raises nothing while the kill switch is off", () => {
    vi.stubEnv("OFFLINE_PAYMENT_CONFIRM", "false");
    try {
      saveBookings([booking(TX)]);
      expect(watchPaidIncreases([{ bookingId: TX, amountPaid: 10 }])).toBe(0);
      expect(ingestPaymentHistories([{ bookingId: TX, ok: true, events: [charge(6, 1000, "2026-11-10T05:00:00Z")] }], NOW).cardsRaised).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("bank deposits", () => {
  it("matches by project number, is idempotent, and shows on the next card (a non-check deposit never confirms)", () => {
    saveBookings([booking(TX)]);
    const first = recordBankDeposit({ transactionId: "mx-1", amount: 1026.51, postedAt: "2026-11-06T15:00:00Z", note: `Project ${TX}`, accountName: "Check Deposit", kind: "externalTransfer" }, NOW);
    expect(first.confirm).toBeUndefined();
    expect(first).toMatchObject({ ok: true, depositId: "mx-1", match: { bookingId: TX, kind: "project_number" } });
    expect(recordBankDeposit({ transactionId: "mx-1", amount: 1026.51 }, NOW)).toMatchObject({ duplicate: true });

    vi.stubEnv("OFFLINE_PAYMENT_AUTO_SEND", "false");
    ingestPaymentHistories([{ bookingId: TX, ok: true, events: [charge(7, 102651, "2026-11-10T05:00:00Z")] }], NOW);
    const [card] = listPendingApprovals();
    expect(card.card.dataUsed).toContain("bank deposit of $1,026.51 on November 6 (Check Deposit) matched by project number in the memo");
    vi.unstubAllEnvs();
  });

  it("matches a unique 50% deposit and ignores money out", () => {
    saveBookings([booking(TX, { grandTotal: 3000 })]);
    expect(recordBankDeposit({ id: "d2", amount: 1500 }, NOW).match).toMatchObject({ bookingId: TX, kind: "deposit_50" });
    expect(recordBankDeposit({ id: "d3", amount: -40 }, NOW)).toMatchObject({ ignored: "not a deposit" });
  });
});

describe("helpers", () => {
  it("balance is total minus paid, never negative", () => {
    expect(remainingFrom({ grandTotalCents: 205301, paidCents: 102651 })).toBe(1026.5);
    expect(remainingFrom({ grandTotalCents: 100, paidCents: 500 })).toBe(0);
    expect(remainingFrom({ grandTotalCents: null, paidCents: 5 })).toBeNull();
  });

  it("bank webhook token: open until set, then must match", () => {
    const h = (k: string, v: string) => new Headers({ [k]: v });
    expect(bankTokenOk(new Headers(), {})).toBe(true);
    expect(bankTokenOk(h("x-bank-token", "a"), { BANK_WEBHOOK_TOKEN: "a" })).toBe(true);
    expect(bankTokenOk(h("x-bank-token", "b"), { BANK_WEBHOOK_TOKEN: "a" })).toBe(false);
    expect(bankTokenOk(h("x-wire-token", "w"), { WIRE_WEBHOOK_TOKEN: "w" })).toBe(true);
  });
});

describe("check confirmation from the bank (owner, 2026-11-14)", () => {
  const dep = (id: string, over: Record<string, unknown> = {}) => ({ transactionId: id, amount: 1026.51, postedAt: "2026-11-09T15:00:00Z", note: `Project ${TX}`, account: "Revenue - Check Deposit", kind: "checkDeposit", ...over });

  it("a cleared check matched by project number confirms on its own, and the later Goodshuffle payment does not confirm again", async () => {
    saveBookings([booking(TX, { amountDue: 2053.01 })]);
    const r = recordBankDeposit(dep("chk-1"), NOW);
    expect(r.confirm).toMatchObject({ state: "sent" });
    expect(listPendingApprovals().filter((a) => a.actionType === "confirm_payment")).toHaveLength(0);
    const [email] = ops("email_template");
    expect(email.payload).toMatchObject({ templateId: "61182", fillAmount: "1,026.51", dedupeKey: "offline-payment:deposit:chk-1" });
    await tick();
    expect(texts).toHaveLength(1);
    expect(texts[0].body).toContain("We received your check payment of $1,026.51");
    expect(texts[0].body).toContain("Your remaining balance of $1,026.50 is due by December 5.");
    expect((announced[0] as { title: string }).title).toBe("Check payment confirmed to the customer");

    // The team records it in Goodshuffle by hand; the pull links it to the deposit instead of confirming twice.
    const g = ingestPaymentHistories([{ bookingId: TX, ok: true, grandTotalCents: 205301, paidCents: 102651, events: [charge(9001, 102651, "2026-11-10T05:00:00Z")] }], NOW);
    expect(g).toMatchObject({ newPayments: 1, cardsRaised: 0, skipped: [{ paymentId: "9001", reason: "confirmed_by_deposit" }] });
    await tick();
    expect(texts).toHaveLength(1);
    expect(ops("email_template")).toHaveLength(1);
    expect(getDb().prepare("SELECT gs_payment_id, confirm_state FROM bank_deposits WHERE deposit_id = 'chk-1'").get()).toEqual({ gs_payment_id: "9001", confirm_state: "sent" });
  });

  it("a check Goodshuffle already confirmed is not confirmed again when the deposit posts", async () => {
    saveBookings([booking(TX)]);
    ingestPaymentHistories([{ bookingId: TX, ok: true, events: [charge(9002, 102651, "2026-11-10T05:00:00Z")] }], NOW);
    await tick();
    expect(texts).toHaveLength(1);
    const r = recordBankDeposit(dep("chk-2", { postedAt: "2026-11-11T15:00:00Z" }), NOW);
    expect(r.confirm).toMatchObject({ state: "already_confirmed" });
    await tick();
    expect(texts).toHaveLength(1);
    expect(ops("email_template")).toHaveLength(1);
  });

  it("two equal checks on one project (deposit and balance) each get one confirmation", async () => {
    saveBookings([booking(TX)]);
    recordBankDeposit(dep("chk-a", { postedAt: "2026-10-20T15:00:00Z" }), NOW);
    ingestPaymentHistories([{ bookingId: TX, ok: true, events: [charge(9003, 102651, "2026-10-21T05:00:00Z")] }], NOW);
    recordBankDeposit(dep("chk-b", { postedAt: "2026-11-10T15:00:00Z" }), NOW);
    ingestPaymentHistories([{ bookingId: TX, ok: true, events: [charge(9003, 102651, "2026-10-21T05:00:00Z"), charge(9004, 102651, "2026-11-11T05:00:00Z")] }], NOW);
    await tick();
    expect(texts).toHaveLength(2);
    expect(ops("email_template")).toHaveLength(2);
  });

  it("never fires for ACH, wires or an ambiguous match", async () => {
    saveBookings([booking(TX, { grandTotal: 3000 }), booking("231812126", { grandTotal: 3000 })]);
    expect(recordBankDeposit(dep("ach-1", { kind: "externalTransfer" }), NOW).confirm).toBeUndefined();
    expect(recordBankDeposit(dep("wire-1", { kind: "incomingDomesticWire" }), NOW).confirm).toBeUndefined();
    const amb = recordBankDeposit({ transactionId: "chk-amb", amount: 1500, kind: "checkDeposit", account: "Revenue - Check Deposit" }, NOW);
    expect(amb.match?.kind).toBe("ambiguous");
    expect(amb.confirm).toBeUndefined();
    await tick();
    expect(texts).toHaveLength(0);
    expect(ops("email_template")).toHaveLength(0);
  });

  it("the kill switch stops the bank side too", () => {
    vi.stubEnv("OFFLINE_PAYMENT_CONFIRM", "false");
    try {
      saveBookings([booking(TX)]);
      expect(recordBankDeposit(dep("chk-off"), NOW).confirm).toMatchObject({ state: "skipped" });
      expect(ops("email_template")).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
