import { describe, it, expect } from "vitest";
import {
  extractRevenueComponents,
  centsToDollars,
  revenueModelFromResponse,
  type RawRevenueResponse,
} from "./revenueModel";

// A representative loadPaymentHistoryAndContractTotals response (CENTS), using the EXACT captured field
// names from the Stage-3 brief. Clean round numbers so the ÷100 expectations are obvious.
const FULL: RawRevenueResponse = {
  contractOriginalSubTotal: 500000, // quoted basis → $5000
  contractProductSubTotal: 400000, // $4000
  contractProductRentalsSubTotal: 300000, // $3000
  contractProductSalesSubTotal: 100000, // $1000
  contractServiceSubTotal: 50000, // $500
  contractLogisticsSubTotal: 50000, // $500 delivery
  contractDetachedItemSubTotal: 0,
  contractDiscountSubTotal: 20000, // $200
  contractDiscount: 15000, // $150
  contractAdditionalDiscount: 5000, // $50
  contractTaxableSubTotal: 480000, // $4800
  effectiveTaxRate: "0.06",
  taxMap: { total: 28800 }, // $288
  contractTotal: 508800, // $5088
  grandTotal: 508800, // $5088
  paymentHistory: {
    totalContractApplicablePaid: 254400, // $2544 collected
    totalSuccessfulRefunds: 10000, // $100 refunds
    onlinePaymentsProcessingFeesTotal: 7000, // $70
    offlinePaymentsProcessingFeesTotal: 0,
    paymentEvents: [{ goodshuffleFeeAmount: 2000 }, { goodshuffleFeeAmount: 1000 }], // $30 total
  },
};

describe("revenueModel — extract + convert the captured response shape", () => {
  it("extracts every component in CENTS using the exact GS field names", () => {
    const c = extractRevenueComponents(FULL);
    expect(c.quotedSubtotal).toBe(500000);
    expect(c.productSubtotal).toBe(400000);
    expect(c.productRentalsSubtotal).toBe(300000);
    expect(c.productSalesSubtotal).toBe(100000);
    expect(c.serviceSubtotal).toBe(50000);
    expect(c.logisticsSubtotal).toBe(50000);
    expect(c.detachedItemSubtotal).toBe(0);
    expect(c.discount).toBe(15000);
    expect(c.additionalDiscount).toBe(5000);
    expect(c.discountSubtotal).toBe(20000);
    expect(c.taxableSubtotal).toBe(480000);
    expect(c.taxTotal).toBe(28800); // taxMap.total
    expect(c.effectiveTaxRate).toBe(0.06); // a RATE, parsed from string
    expect(c.collected).toBe(254400);
    expect(c.refunds).toBe(10000);
    expect(c.processingFees).toBe(7000); // online + offline
    expect(c.goodshuffleFees).toBe(3000); // Σ paymentEvents[].goodshuffleFeeAmount
  });

  it("converts money CENTS → DOLLARS but leaves effectiveTaxRate (a rate) untouched", () => {
    const d = centsToDollars(extractRevenueComponents(FULL));
    expect(d.grandTotal).toBe(5088);
    expect(d.quotedSubtotal).toBe(5000);
    expect(d.taxTotal).toBe(288);
    expect(d.collected).toBe(2544);
    expect(d.refunds).toBe(100);
    expect(d.effectiveTaxRate).toBe(0.06); // NOT divided by 100
  });

  it("builds the full model (dollars) with derived totals + honest labels", () => {
    const m = revenueModelFromResponse(FULL, true);
    expect(m.quotedSubtotal).toBe(5000);
    expect(m.grandTotal).toBe(5088);
    expect(m.logisticsSubtotal).toBe(500);
    expect(m.discountsTotal).toBe(200); // discount + additionalDiscount
    expect(m.taxTotal).toBe(288);
    expect(m.feesTotal).toBe(100); // processing 70 + goodshuffle 30
    expect(m.collected).toBe(2544);
    expect(m.refunds).toBe(100);
    expect(m.netCollected).toBe(2444); // collected − refunds
    expect(m.contractedStatus).toBe("SIGNED"); // signed=true
    expect(m.collectedStatus).toBe("ACTUAL");
  });

  it("invoiced is ALWAYS absent (not a Goodshuffle state) — never invented", () => {
    const m = revenueModelFromResponse(FULL, true);
    expect(m.invoiced).toBeNull();
    expect(m.invoicedStatus).toBe("UNAVAILABLE");
    expect(m.notes.some((n) => /invoiced is not a distinct goodshuffle state/i.test(n))).toBe(true);
    expect(m.notes.some((n) => /refunds reduce net/i.test(n))).toBe(true);
  });

  it("an unsigned quote labels the contracted figure PROJECTED, not SIGNED", () => {
    expect(revenueModelFromResponse(FULL, false).contractedStatus).toBe("PROJECTED");
  });
});

describe("revenueModel — missing/sparse data stays null (NEVER fabricated or zeroed)", () => {
  it("an empty response yields all-null components and UNAVAILABLE statuses", () => {
    const m = revenueModelFromResponse({}, false);
    expect(m.grandTotal).toBeNull();
    expect(m.collected).toBeNull();
    expect(m.discountsTotal).toBeNull(); // no discount contributors → null, not 0
    expect(m.feesTotal).toBeNull();
    expect(m.netCollected).toBeNull();
    expect(m.contractedStatus).toBe("UNAVAILABLE");
    expect(m.collectedStatus).toBe("UNAVAILABLE");
    expect(m.invoiced).toBeNull();
  });

  it("a partial response keeps known figures and leaves the rest null", () => {
    const m = revenueModelFromResponse(
      { grandTotal: 200000, paymentHistory: { totalContractApplicablePaid: 50000, onlinePaymentsProcessingFeesTotal: 1500 } },
      true,
    );
    expect(m.grandTotal).toBe(2000);
    expect(m.collected).toBe(500);
    expect(m.refunds).toBeNull();
    expect(m.netCollected).toBe(500); // refunds unknown → treated as 0 for the net, not fabricated
    expect(m.processingFees).toBe(15);
    expect(m.goodshuffleFees).toBeNull(); // no paymentEvents → null, not 0
    expect(m.feesTotal).toBe(15); // only the known contributor
    expect(m.quotedSubtotal).toBeNull();
    expect(m.notes.some((n) => /refunds reduce net/i.test(n))).toBe(false); // no refund → no refund note
  });

  it("a non-numeric tax rate parses to null (never NaN)", () => {
    expect(extractRevenueComponents({ effectiveTaxRate: "6%" }).effectiveTaxRate).toBeNull();
    expect(extractRevenueComponents({ effectiveTaxRate: 0.0725 }).effectiveTaxRate).toBe(0.0725);
  });

  it("is defensive against null/garbage input", () => {
    expect(() => revenueModelFromResponse(null, false)).not.toThrow();
    expect(() => revenueModelFromResponse(undefined, false)).not.toThrow();
  });
});
