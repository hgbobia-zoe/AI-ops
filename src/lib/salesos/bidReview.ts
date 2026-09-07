// Competitive Bid Review — the deterministic core. RULES CALCULATE: "is this bid priced to win?" is
// answered from Zoe's OWN won/lost history at comparable price points — real DMV-market behavior, not
// invented industry benchmarks. We never fabricate competitor prices; when history is too thin we say
// so (verdict "insufficient") rather than guess.

export interface BidInput {
  value: number; // the proposed bid $ (grand total)
  month?: number; // 1–12, the event month, for a light seasonal read
}

export interface DecidedDeal {
  value: number; // $ grand total
  won: boolean; // true = Contract Signed, false = Lost
  month?: number | null; // event month 1–12
}

export type BidVerdict = "competitive" | "aggressive" | "conservative" | "insufficient";

export interface BidReview {
  value: number;
  comparables: number; // decided deals within the size window
  wonComparables: number;
  lostComparables: number;
  winRate: number | null; // win rate among comparable-sized deals (0..1)
  wonRange: { p25: number; median: number; p75: number } | null; // where your WINNING bids clustered
  percentileAmongWins: number | null; // where this bid sits within won deals (0..1)
  seasonWinRate: number | null; // win rate for the event month, if provided & enough data
  verdict: BidVerdict;
  confidence: "low" | "medium" | "high"; // by comparable sample size
  reasons: string[]; // plain, number-traceable
}

/** Comparable-size window: decided deals within ±40% of the bid. Wide enough for signal, tight enough
 *  to be "similar-sized". */
const WINDOW = 0.4;
const MIN_COMPARABLES = 8; // below this we won't draw a verdict

const sortNum = (a: number[]): number[] => [...a].sort((x, y) => x - y);
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
/** Fraction of values <= v (where this bid sits in the distribution). */
function percentile(sorted: number[], v: number): number {
  if (sorted.length === 0) return NaN;
  let c = 0;
  for (const x of sorted) if (x <= v) c++;
  return c / sorted.length;
}

const money = (n: number): string => "$" + Math.round(n).toLocaleString("en-US");
const pctStr = (r: number): string => `${Math.round(r * 100)}%`;

/** Review a bid against comparable-sized decided deals. Pure + total. */
export function bidReview(input: BidInput, history: DecidedDeal[]): BidReview {
  const value = input.value;
  const lo = value * (1 - WINDOW);
  const hi = value * (1 + WINDOW);
  const comps = history.filter((d) => Number.isFinite(d.value) && d.value >= lo && d.value <= hi);
  const wonComps = comps.filter((d) => d.won);
  const lostComps = comps.filter((d) => !d.won);
  const comparables = comps.length;

  const wonVals = sortNum(wonComps.map((d) => d.value));
  const winRate = comparables > 0 ? wonComps.length / comparables : null;
  const wonRange = wonVals.length >= 4 ? { p25: quantile(wonVals, 0.25), median: quantile(wonVals, 0.5), p75: quantile(wonVals, 0.75) } : null;
  const percentileAmongWins = wonVals.length >= 4 ? percentile(wonVals, value) : null;

  // Seasonal read (only when asked and there's enough month data).
  let seasonWinRate: number | null = null;
  if (input.month) {
    const monthDeals = history.filter((d) => d.month === input.month);
    if (monthDeals.length >= MIN_COMPARABLES) seasonWinRate = monthDeals.filter((d) => d.won).length / monthDeals.length;
  }

  const confidence = comparables >= 40 ? "high" : comparables >= MIN_COMPARABLES ? "medium" : "low";
  const reasons: string[] = [];

  let verdict: BidVerdict;
  if (comparables < MIN_COMPARABLES || !wonRange) {
    verdict = "insufficient";
    reasons.push(`Only ${comparables} comparable-sized deal${comparables === 1 ? "" : "s"} in your history (need ${MIN_COMPARABLES}+) — not enough to judge this price confidently.`);
  } else {
    if (winRate != null) reasons.push(`Deals near this size (${money(lo)}–${money(hi)}) win ${pctStr(winRate)} of the time — ${wonComps.length} won, ${lostComps.length} lost.`);
    reasons.push(`Your winning bids at this size clustered ${money(wonRange.p25)}–${money(wonRange.p75)} (median ${money(wonRange.median)}).`);

    if (value > wonRange.p75) {
      verdict = "aggressive";
      reasons.push(`At ${money(value)} this bid is above 3 out of 4 of your past wins here (${percentileAmongWins != null ? pctStr(percentileAmongWins) : "high"} percentile) — expect a tougher close. Sharpen the value story, or revisit price.`);
    } else if (value < wonRange.p25) {
      verdict = "conservative";
      reasons.push(`At ${money(value)} this bid is below most of your past wins — likely to close, but you may be leaving margin on the table.`);
    } else {
      verdict = "competitive";
      reasons.push(`At ${money(value)} this bid sits right in your winning range — priced to compete.`);
    }
  }

  if (seasonWinRate != null && winRate != null && Math.abs(seasonWinRate - winRate) >= 0.1) {
    reasons.push(`Seasonally, ${monthName(input.month!)} closes at ${pctStr(seasonWinRate)} vs ${pctStr(winRate)} overall — ${seasonWinRate > winRate ? "a favorable month" : "a harder month"}.`);
  }

  return { value, comparables, wonComparables: wonComps.length, lostComparables: lostComps.length, winRate, wonRange, percentileAmongWins, seasonWinRate, verdict, confidence, reasons };
}

const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function monthName(m: number): string {
  return MONTHS[m] ?? String(m);
}
