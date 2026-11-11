import { describe, expect, it } from "vitest";
import {
  offlineCharges,
  isRecent,
  buildConfirmSms,
  buildConfirmCard,
  buildConfirmNote,
  confirmTitle,
  finalPaymentDue,
  templateId,
  templateName,
  amountDigits,
  DEFAULT_TEMPLATE_NAME,
  type ConfirmContext,
  type OfflinePayment,
} from "./offlineConfirm";

// The real event shape, captured read only from Goodshuffle on 2026-11-11 (amount in CENTS).
const checkEvent = {
  id: 1143998117,
  type: "charge",
  offlinePayment: true,
  paymentType: "CHECK",
  label: "Offline - Check",
  amount: 102651,
  dateMillis: Date.parse("2026-11-09T05:00:00Z"),
  status: "Charged",
  processedBy: "Cindy Gbobia",
};

const payment: OfflinePayment = {
  paymentId: "1143998117",
  amount: 1026.51,
  method: "CHECK",
  methodLabel: "Offline - Check",
  paidAt: "2026-11-09T05:00:00.000Z",
  recordedBy: "Cindy Gbobia",
};

const ctx = (over: Partial<ConfirmContext> = {}): ConfirmContext => ({
  payment,
  bookingId: "231812125",
  clientName: "hermann Gbobia",
  salesLead: "Jessie Medalla",
  eventDate: "2026-12-12",
  remainingBalance: 1026.5,
  todayYmd: "2026-11-11",
  ...over,
});

const NO_DASH_OR_EMOJI = /[—–]|\s-\s|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

describe("offlineCharges", () => {
  it("reads a cleared check into dollars, method and who recorded it", () => {
    expect(offlineCharges([checkEvent])).toEqual([payment]);
  });

  it("ignores card charges, authorizations, refunds, failed and zero amounts", () => {
    const out = offlineCharges([
      { ...checkEvent, id: 1, offlinePayment: false, label: "Visa Debit x2678" },
      { ...checkEvent, id: 2, type: "authorization" },
      { ...checkEvent, id: 3, type: "refund" },
      { ...checkEvent, id: 4, status: "Failed" },
      { ...checkEvent, id: 5, amount: 0 },
      { ...checkEvent, id: null },
    ]);
    expect(out).toEqual([]);
  });

  it("falls back to the label when Goodshuffle sends no payment type (ACH)", () => {
    const [p] = offlineCharges([{ ...checkEvent, paymentType: null, label: "Offline - ACH" }]);
    expect(p.method).toBe("ACH");
  });
});

describe("isRecent", () => {
  const now = Date.parse("2026-11-11T15:00:00Z");
  it("confirms a payment inside the look-back and skips older history", () => {
    expect(isRecent("2026-11-01T00:00:00Z", now, 21)).toBe(true);
    expect(isRecent("2026-09-01T00:00:00Z", now, 21)).toBe(false);
  });
  it("treats a payment with no date as recent (it just appeared)", () => {
    expect(isRecent(null, now, 21)).toBe(true);
  });
});

describe("buildConfirmSms", () => {
  it("names the lead, the method, the amount and the balance due 7 days before the event", () => {
    const sms = buildConfirmSms(ctx());
    expect(sms).toBe(
      "Hi Hermann, this is Jessie from Zoe Events. We received your check payment of $1,026.51 for your December 12 event and it has cleared. Thank you! Your remaining balance of $1,026.50 is due by December 5. You will also get a confirmation email.",
    );
    expect(sms).not.toMatch(NO_DASH_OR_EMOJI);
  });

  it("says paid in full when nothing is left", () => {
    expect(buildConfirmSms(ctx({ remainingBalance: 0 }))).toContain("Your project is now paid in full.");
  });

  it("does not quote a due date that has already passed", () => {
    const sms = buildConfirmSms(ctx({ eventDate: "2026-11-14" }));
    expect(sms).toContain("Your remaining balance is $1,026.50.");
    expect(sms).not.toContain("due by");
  });

  it("stays polite without a lead, a name or an event date", () => {
    const sms = buildConfirmSms(ctx({ salesLead: null, clientName: "", eventDate: null, remainingBalance: null }));
    expect(sms.startsWith("Hi, this is the Zoe Events team. We received your check payment of $1,026.51 and it has cleared.")).toBe(true);
  });
});

describe("finalPaymentDue", () => {
  it("is the event date minus 7 days, across a month edge", () => {
    expect(finalPaymentDue("2026-12-03")).toBe("2026-11-26");
    expect(finalPaymentDue(null)).toBeNull();
  });
});

describe("card, title, note", () => {
  it("fills every card field from the payment facts and flags a missing bank deposit", () => {
    const card = buildConfirmCard(ctx(), DEFAULT_TEMPLATE_NAME);
    for (const v of Object.values(card)) expect(v.length).toBeGreaterThan(10);
    expect(card.what).toContain(DEFAULT_TEMPLATE_NAME);
    expect(card.dataUsed).toContain("1143998117");
    expect(card.why).toContain("Cindy Gbobia recorded");
    expect(card.risk).toContain("No matching bank deposit");
  });

  it("shows a matched bank deposit as proof", () => {
    const card = buildConfirmCard(ctx({ bank: { depositId: "tx1", amount: 1026.51, postedAt: "2026-11-06T00:00:00Z", account: "Check Deposit", how: "project number in the memo" } }), DEFAULT_TEMPLATE_NAME);
    expect(card.dataUsed).toContain("bank deposit of $1,026.51 on November 6 (Check Deposit) matched by project number in the memo");
    expect(card.risk).not.toContain("No matching bank deposit");
  });

  it("titles the card with method, amount and customer", () => {
    expect(confirmTitle(ctx())).toBe("Confirm check payment $1,026.51: hermann Gbobia");
  });

  it("logs a note in the team's format naming the approver and each send's outcome", () => {
    const line = buildConfirmNote({ approver: "Hermann Gbobia", payment, tplName: DEFAULT_TEMPLATE_NAME, emailQueued: true, smsOutcome: "text sent", todayYmd: "2026-11-11" });
    expect(line.startsWith("HG(by SalesOS) - 11/11 - Payment confirmation approved by Hermann Gbobia: check payment of $1,026.51 (November 9), recorded by Cindy Gbobia.")).toBe(true);
    expect(line).toContain("text sent");
    expect(line).toContain("queued");
  });
});

describe("template config", () => {
  it("defaults to the owner's template by id and name", () => {
    expect(templateName({})).toBe(DEFAULT_TEMPLATE_NAME);
    expect(templateId({})).toBe("61182");
  });
  it("a renamed template is matched by name only unless an id is given", () => {
    expect(templateId({ PAYMENT_CONFIRM_TEMPLATE: "Payment Cleared" })).toBeNull();
    expect(templateId({ PAYMENT_CONFIRM_TEMPLATE: "Payment Cleared", PAYMENT_CONFIRM_TEMPLATE_ID: "777" })).toBe("777");
  });
  it("formats the fill amount with no dollar sign", () => {
    expect(amountDigits(1026.5)).toBe("1,026.50");
  });
});
