// Event Readiness Service (setup and/or breakdown labor — gathering chairs, removing cushions, etc.).
// Flat fee tiered by the order value (quote subtotal BEFORE discount), per Zoe's price list:
//
//     under $500 → $75 · $500–$1,500 → $150 · $1,500–$3,000 → $250 · $3,000+ → $350+
//
// Lower bound inclusive, upper exclusive: exactly $500 → $150, $1,500 → $250, $3,000 → $350. The top
// tier is a FLOOR ("$350+") — very large orders may be quoted higher by hand.

export interface ReadinessTier {
  min: number; // inclusive
  max: number | null; // exclusive; null = open-ended
  fee: number;
  floor: boolean; // true = "$350+", a starting price
}

export const READINESS_TIERS: ReadinessTier[] = [
  { min: 0, max: 500, fee: 75, floor: false },
  { min: 500, max: 1500, fee: 150, floor: false },
  { min: 1500, max: 3000, fee: 250, floor: false },
  { min: 3000, max: null, fee: 350, floor: true },
];

/** The Event Readiness fee for an order of `subtotal` dollars (pre-discount). */
export function eventReadinessFee(subtotal: number): number {
  return readinessTier(subtotal).fee;
}

/** The full tier (fee + whether it's a floor) for an order value. */
export function readinessTier(subtotal: number): ReadinessTier {
  const s = Math.max(0, subtotal || 0);
  return READINESS_TIERS.find((t) => s >= t.min && (t.max === null || s < t.max)) ?? READINESS_TIERS[0];
}

/** Display fee, e.g. "$150" or "$350+" for the open-ended top tier. */
export function readinessFeeLabel(subtotal: number): string {
  const t = readinessTier(subtotal);
  return `$${t.fee}${t.floor ? "+" : ""}`;
}
