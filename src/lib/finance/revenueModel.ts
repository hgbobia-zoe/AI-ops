// Financial Intelligence — Stage 3 revenue reconstruction (PURE: no DB, no network, no clock).
// Normalizes Goodshuffle's `loadPaymentHistoryAndContractTotals` response into a deterministic
// revenue-components model: quoted vs contracted, the subtotal families (product/service/logistics),
// discounts, tax, platform/processing fees, collected, refunds, and net — each honestly labeled.
//
// Governing laws enforced here: RULES CALCULATE, NEVER FABRICATE. Goodshuffle sends amounts in CENTS;
// this module converts to dollars (÷100) exactly once, at `centsToDollars`, matching the existing ingest
// discipline. A field Goodshuffle does not send stays null (UNAVAILABLE) — NEVER zeroed, NEVER invented.
// `effectiveTaxRate` is a RATE (e.g. 0.06), not money, so it is carried through unchanged (never ÷100).
//
// INVOICED is deliberately absent: GSPRO has no distinct "invoiced" revenue state (the closest is
// amount-due / the signed payment schedule). We label that absence honestly (invoiced = null,
// invoicedStatus = "UNAVAILABLE") rather than inventing a number — see the field map in the Stage-3 brief.

import { type MoneyStatus } from "./calc";

/** The subset of the `loadPaymentHistoryAndContractTotals` response this module reads. Everything is
 *  optional + loosely typed because it arrives from a live third-party endpoint (never assume shape). */
export interface RawRevenueResponse {
  contractOriginalSubTotal?: unknown;
  contractProductSubTotal?: unknown;
  contractProductRentalsSubTotal?: unknown;
  contractProductSalesSubTotal?: unknown;
  contractServiceSubTotal?: unknown;
  contractLogisticsSubTotal?: unknown;
  contractDetachedItemSubTotal?: unknown;
  contractDiscountSubTotal?: unknown;
  contractDiscount?: unknown;
  contractAdditionalDiscount?: unknown;
  contractTaxableSubTotal?: unknown;
  effectiveTaxRate?: unknown; // string/number decimal rate, e.g. "0.06"
  taxMap?: { total?: unknown } | null;
  contractTotal?: unknown;
  grandTotal?: unknown;
  paymentHistory?: {
    totalContractApplicablePaid?: unknown;
    totalSuccessfulRefunds?: unknown;
    onlinePaymentsProcessingFeesTotal?: unknown;
    offlinePaymentsProcessingFeesTotal?: unknown;
    paymentEvents?: Array<{ goodshuffleFeeAmount?: unknown } | null | undefined> | null;
  } | null;
}

/** The flat revenue-component set, in whatever unit the field name's suffix implies. Money fields are
 *  CENTS as pulled, DOLLARS once run through `centsToDollars`. `effectiveTaxRate` is ALWAYS a rate. */
export interface RevenueComponentFields {
  /** contractOriginalSubTotal — the pre-discount quoted basis (the "quoted" state). */
  quotedSubtotal: number | null;
  /** contractTotal — the contracted total before any grand-total adjustments. */
  contractTotal: number | null;
  /** grandTotal — the contracted revenue basis (what `bookings.grand_total` already holds). */
  grandTotal: number | null;
  // Subtotal families (what the contract is made of).
  productSubtotal: number | null;
  productRentalsSubtotal: number | null;
  productSalesSubtotal: number | null;
  serviceSubtotal: number | null;
  logisticsSubtotal: number | null; // delivery
  detachedItemSubtotal: number | null;
  // Discounts.
  discount: number | null;
  additionalDiscount: number | null;
  discountSubtotal: number | null;
  // Tax.
  taxableSubtotal: number | null;
  taxTotal: number | null; // taxMap.total
  effectiveTaxRate: number | null; // a RATE (e.g. 0.06), never a money amount
  // Collection.
  collected: number | null; // paymentHistory.totalContractApplicablePaid
  refunds: number | null; // paymentHistory.totalSuccessfulRefunds
  // Platform/processing fees — a COST to Zoe, not customer revenue.
  processingFees: number | null; // online + offline processing fees
  goodshuffleFees: number | null; // Σ paymentEvents[].goodshuffleFeeAmount
}

/** Alias to keep call sites self-documenting about the unit at each boundary. */
export type RevenueComponentsCents = RevenueComponentFields;
export type RevenueComponentsDollars = RevenueComponentFields;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse a decimal rate that may arrive as a string ("0.06") or a number. Non-finite → null. */
const rate = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Σ of the KNOWN contributors; null only when EVERY contributor is null (so an all-missing fee set is
 *  UNAVAILABLE, never a fake 0). Integer-cent inputs stay exact; dollar inputs are penny-rounded. */
const sumOrNull = (values: (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v != null);
  if (known.length === 0) return null;
  return round2(known.reduce((a, b) => a + b, 0));
};

/**
 * PURE extraction of the revenue components (in CENTS) from the raw response. Defensive: a missing or
 * non-numeric field becomes null (never 0). This is the exact set the office pull carries on the wire and
 * the ingest persists; the bookmarklet mirrors this extraction inline (it cannot import — see gsPull.ts).
 */
export function extractRevenueComponents(raw: RawRevenueResponse | null | undefined): RevenueComponentsCents {
  const r = raw ?? {};
  const ph = r.paymentHistory ?? {};
  const events = Array.isArray(ph.paymentEvents) ? ph.paymentEvents : [];
  const gsFees = sumOrNull(events.map((e) => num(e?.goodshuffleFeeAmount)));
  return {
    quotedSubtotal: num(r.contractOriginalSubTotal),
    contractTotal: num(r.contractTotal),
    grandTotal: num(r.grandTotal),
    productSubtotal: num(r.contractProductSubTotal),
    productRentalsSubtotal: num(r.contractProductRentalsSubTotal),
    productSalesSubtotal: num(r.contractProductSalesSubTotal),
    serviceSubtotal: num(r.contractServiceSubTotal),
    logisticsSubtotal: num(r.contractLogisticsSubTotal),
    detachedItemSubtotal: num(r.contractDetachedItemSubTotal),
    discount: num(r.contractDiscount),
    additionalDiscount: num(r.contractAdditionalDiscount),
    discountSubtotal: num(r.contractDiscountSubTotal),
    taxableSubtotal: num(r.contractTaxableSubTotal),
    taxTotal: num(r.taxMap?.total),
    effectiveTaxRate: rate(r.effectiveTaxRate),
    collected: num(ph.totalContractApplicablePaid),
    refunds: num(ph.totalSuccessfulRefunds),
    processingFees: sumOrNull([num(ph.onlinePaymentsProcessingFeesTotal), num(ph.offlinePaymentsProcessingFeesTotal)]),
    goodshuffleFees: gsFees,
  };
}

/** Convert the money fields from CENTS to DOLLARS (÷100, penny-rounded). `effectiveTaxRate` is a rate and
 *  is carried through untouched. Nulls stay null. This is the one and only unit conversion (house law). */
export function centsToDollars(c: RevenueComponentsCents): RevenueComponentsDollars {
  const d = (v: number | null): number | null => (v == null ? null : round2(v / 100));
  return {
    quotedSubtotal: d(c.quotedSubtotal),
    contractTotal: d(c.contractTotal),
    grandTotal: d(c.grandTotal),
    productSubtotal: d(c.productSubtotal),
    productRentalsSubtotal: d(c.productRentalsSubtotal),
    productSalesSubtotal: d(c.productSalesSubtotal),
    serviceSubtotal: d(c.serviceSubtotal),
    logisticsSubtotal: d(c.logisticsSubtotal),
    detachedItemSubtotal: d(c.detachedItemSubtotal),
    discount: d(c.discount),
    additionalDiscount: d(c.additionalDiscount),
    discountSubtotal: d(c.discountSubtotal),
    taxableSubtotal: d(c.taxableSubtotal),
    taxTotal: d(c.taxTotal),
    effectiveTaxRate: c.effectiveTaxRate, // NOT money — unchanged
    collected: d(c.collected),
    refunds: d(c.refunds),
    processingFees: d(c.processingFees),
    goodshuffleFees: d(c.goodshuffleFees),
  };
}

/** The computed revenue-components model (DOLLARS), with honesty labels + deterministic derived totals. */
export interface RevenueComponents extends RevenueComponentsDollars {
  /** discount + additionalDiscount (sumKnown). The contract's total discount off the quoted basis. */
  discountsTotal: number | null;
  /** processing + Goodshuffle platform fees — a cost to Zoe, not customer revenue. */
  feesTotal: number | null;
  /** collected − refunds (refunds REDUCE net collected). Null when nothing is collected. */
  netCollected: number | null;
  /** GSPRO has no distinct invoiced state — honestly absent, never invented. */
  invoiced: null;
  invoicedStatus: "UNAVAILABLE";
  /** SIGNED (committed) vs PROJECTED (a quote is not revenue) vs UNAVAILABLE. */
  contractedStatus: MoneyStatus;
  /** Collected money is a real figure → ACTUAL (even at 0); UNAVAILABLE when unknown. */
  collectedStatus: MoneyStatus;
  signed: boolean;
  /** Honest labels for the UI — invoiced absence, refund treatment, fee meaning. Never numbers. */
  notes: string[];
}

/** Build the computed model from component DOLLARS + the booking's signed flag. PURE + deterministic. */
export function buildRevenueModel(d: RevenueComponentsDollars, signed: boolean): RevenueComponents {
  const contractedStatus: MoneyStatus = d.grandTotal == null ? "UNAVAILABLE" : signed ? "SIGNED" : "PROJECTED";
  const collectedStatus: MoneyStatus = d.collected == null ? "UNAVAILABLE" : "ACTUAL";
  const discountsTotal = sumOrNull([d.discount, d.additionalDiscount]);
  const feesTotal = sumOrNull([d.processingFees, d.goodshuffleFees]);
  const netCollected = d.collected == null ? null : round2(d.collected - (d.refunds ?? 0));

  const notes: string[] = [
    "Invoiced is not a distinct Goodshuffle state — the closest signal is amount due / the signed payment schedule, so it is left unavailable rather than invented.",
  ];
  if (d.refunds != null && d.refunds > 0) notes.push("Refunds reduce net collected (net = collected − refunds).");
  if (feesTotal != null && feesTotal > 0) notes.push("Processing and Goodshuffle platform fees are a cost to Zoe, shown separately from customer revenue.");

  return {
    ...d,
    discountsTotal,
    feesTotal,
    netCollected,
    invoiced: null,
    invoicedStatus: "UNAVAILABLE",
    contractedStatus,
    collectedStatus,
    signed,
    notes,
  };
}

/**
 * Convenience: the full pipeline — the raw response (CENTS) → components model (DOLLARS). This is the
 * Stage-3 "normalize the loadPaymentHistoryAndContractTotals response into a revenue-components model"
 * entry point, and the shape the unit tests exercise against the captured response fixture.
 */
export function revenueModelFromResponse(raw: RawRevenueResponse | null | undefined, signed: boolean): RevenueComponents {
  return buildRevenueModel(centsToDollars(extractRevenueComponents(raw)), signed);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
