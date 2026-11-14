// Zoe's pricing and payment rules for anything that drafts, coaches or answers sales questions. Owner calls,
// 2026-11-14 (they replace the old "ACH 5 days" and "partner discount needs approval" rules). One place, so
// the drafter, the coach, Viktor and the intake all say the same thing. RULES CALCULATE: the numbers live
// here as data; the prompt text is built from them.

/** The discount a rep can give on their own: industry vendors (partners) always, or a real price objection. */
export const STANDARD_DISCOUNT_PCT = 20;
/** Who can approve anything past the standard discount, or a Sunday event. */
export const FINAL_SAY = "Hermann or Cindy";
/** ACH and check payments need at least this many days before the event; closer than that, credit card. */
export const OFFLINE_PAYMENT_MIN_DAYS = 10;
/** Signed within this many days of the event = the full balance is due at signing (Goodshuffle does it). */
export const FULL_BALANCE_AT_SIGNING_DAYS = 7;
/** Same-day delivery window upgrades, charged PER TIMED LEG. A customer can time just one leg (e.g. Exact
 *  drop-off, Standard pick-up). Elite Hour is a leg after 10 PM. */
export const WINDOW_PRICE_PER_LEG = { premium: 100, exact: 150, elite: 200 } as const;
/** Elite Hour: a delivery or pick-up after this hour (24h clock). */
export const ELITE_HOUR_FROM = 22;
/** Changes inside this many days of the event carry no fee. */
export const FREE_CHANGE_DAYS = 7;
/** No changes inside this many days of the event (we load trucks before the day-before delivery). */
export const NO_CHANGE_DAYS = 3;

/** Can a change request be accepted this many days before the event? PURE. */
export function changeAllowed(daysToEvent: number | null): boolean {
  return daysToEvent == null || daysToEvent > NO_CHANGE_DAYS;
}

/** Can this payment method be used for an event this many days out? PURE. */
export function offlinePaymentAllowed(daysToEvent: number | null): boolean {
  return daysToEvent != null && daysToEvent >= OFFLINE_PAYMENT_MIN_DAYS;
}

/** Is a HH:MM time in the Elite Hour (10 PM or later)? PURE. */
export function isEliteHour(hhmm: string | null | undefined): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? "");
  return !!m && Number(m[1]) >= ELITE_HOUR_FROM;
}

/** Is a YYYY-MM-DD date a Sunday? PURE. */
export function isSunday(ymd: string | null | undefined): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  return !!m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() === 0;
}

/** The rules as a prompt block, house style (no dashes). Append it to any sales system prompt. */
export const SALES_RULES_PROMPT = [
  "Zoe pricing and payment rules (follow them exactly, never invent others):",
  `- Industry vendors (planners, venues, other event companies) get ${STANDARD_DISCOUNT_PCT}% off automatically. No approval needed.`,
  `- For a real price objection a rep may offer up to ${STANDARD_DISCOUNT_PCT}% off. Lead with value first and only offer it when price is the true blocker.`,
  `- The ${STANDARD_DISCOUNT_PCT}% comes off the rental subtotal only, never off delivery, fees or the whole order.`,
  "- Discounts never stack. A vendor who also objects to price still gets one discount.",
  `- Anything past ${STANDARD_DISCOUNT_PCT}% needs ${FINAL_SAY}. Never promise it; say you will check.`,
  `- ACH and check payments need ${OFFLINE_PAYMENT_MIN_DAYS} or more days before the event. Closer than that, payment is by credit card.`,
  `- A contract signed within ${FULL_BALANCE_AT_SIGNING_DAYS} days of the event pays the full balance at signing (Goodshuffle handles it).`,
  `- Delivery windows are charged per timed leg: Premium +$${WINDOW_PRICE_PER_LEG.premium}, Exact +$${WINDOW_PRICE_PER_LEG.exact}, Elite Hour (after 10 PM) +$${WINDOW_PRICE_PER_LEG.elite}. A customer can time just one leg and keep the free Standard window on the other.`,
  `- Changes to an order inside ${FREE_CHANGE_DAYS} days of the event carry no fee.`,
  `- No changes are accepted within ${NO_CHANGE_DAYS} days of the event, including during the event, because trucks are loaded before the day-before delivery. The only exception is when we already have to go back to that location for another reason, and ${FINAL_SAY} decide that case by case. Never agree to a late change yourself.`,
  "- An unsigned quote is marked lost when the event is 3 days away, unless the customer is waiting on us.",
  `- Sunday events are an exception only, with no surcharge. The final yes comes from ${FINAL_SAY}, so never confirm a Sunday yourself.`,
].join("\n");
