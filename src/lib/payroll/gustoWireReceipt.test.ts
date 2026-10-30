import { describe, expect, it } from "vitest";
import {
  parseUsdAmount,
  parseReceiptDate,
  normalizeGustoReceipt,
  receiptDedupKey,
  gustoReceiptCard,
} from "./gustoWireReceipt";
import type { WirePeriodMatch } from "./wireEvent";

describe("parseUsdAmount", () => {
  it("pulls the amount out of the Gusto email body", () => {
    expect(parseUsdAmount("We received your wire transfer of $2,158.58 on Friday, October 30!")).toBe(2158.58);
  });
  it("handles whole-dollar and no-comma amounts", () => {
    expect(parseUsdAmount("$1,000")).toBe(1000);
    expect(parseUsdAmount("$42.00")).toBe(42);
  });
  it("returns null when there is no amount", () => {
    expect(parseUsdAmount("no money mentioned here")).toBeNull();
    expect(parseUsdAmount(null)).toBeNull();
  });
});

describe("parseReceiptDate", () => {
  it("accepts ISO and human dates, normalizing to yyyy-mm-dd (UTC)", () => {
    expect(parseReceiptDate("2026-10-30")).toBe("2026-10-30");
    expect(parseReceiptDate("Oct 30, 2026")).toBe("2026-10-30");
  });
  it("returns null when unparseable", () => {
    expect(parseReceiptDate("Friday")).toBeNull();
    expect(parseReceiptDate(null)).toBeNull();
  });
});

describe("normalizeGustoReceipt", () => {
  it("prefers a structured amount, falling back to parsing the text", () => {
    expect(normalizeGustoReceipt({ amount: -2158.58, text: "ignored $9.99" }).amountAbs).toBe(2158.58);
    expect(normalizeGustoReceipt({ text: "received $2,158.58 today" }).amountAbs).toBe(2158.58);
  });
  it("captures the message id and date", () => {
    const r = normalizeGustoReceipt({ text: "$500", date: "2026-10-30", messageId: "gmail-abc" });
    expect(r).toMatchObject({ amountAbs: 500, date: "2026-10-30", messageId: "gmail-abc" });
  });
  it("never throws on junk input", () => {
    expect(normalizeGustoReceipt(null)).toMatchObject({ amountAbs: null, messageId: null });
    expect(normalizeGustoReceipt(42).amountAbs).toBeNull();
  });
});

describe("receiptDedupKey", () => {
  it("uses the Gmail message id when present", () => {
    expect(receiptDedupKey({ amountAbs: 500, date: "2026-10-30", messageId: "gmail-abc", rawText: "" })).toBe("gusto-recv:gmail-abc");
  });
  it("falls back to amount+date so a retry still dedups", () => {
    expect(receiptDedupKey({ amountAbs: 2158.58, date: "2026-10-30", messageId: null, rawText: "" })).toBe("gusto-recv:2158.58:2026-10-30");
  });
});

describe("gustoReceiptCard", () => {
  const period: WirePeriodMatch = {
    periodStart: "2026-10-19", periodEnd: "2026-10-25", periodLabel: "Oct 19 – Oct 25", expectedTotal: 2158.58, source: "x", deltaPct: 0,
  };
  it("renders amount, received date and pay period", () => {
    const card = gustoReceiptCard({ amountAbs: 2158.58, date: "2026-10-30", messageId: null, rawText: "" }, period);
    expect(card.title).toBe("Gusto confirmed the payroll wire");
    const labels = (card.fields ?? []).map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(["Amount", "Received", "Pay period", "Confirmed by"]));
    expect(card.body).toContain("Payroll is funded");
  });
  it("omits the pay-period line when the wire could not be correlated", () => {
    const card = gustoReceiptCard({ amountAbs: 2158.58, date: "2026-10-30", messageId: null, rawText: "" }, null);
    expect(card.body).not.toContain("pay period");
    expect((card.fields ?? []).map((f) => f.label)).not.toContain("Pay period");
  });
  it("carries no dashes or emoji (house style)", () => {
    const card = gustoReceiptCard({ amountAbs: 2158.58, date: "2026-10-30", messageId: null, rawText: "" }, period);
    expect(card.body!).not.toMatch(/[—–]|\s-\s/);
    expect(card.body!).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u);
  });
});
