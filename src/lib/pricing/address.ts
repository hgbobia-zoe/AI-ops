// Address precision for delivery pricing. Goodshuffle's project search gives only city + state + ZIP, and a
// town-only geocode lands on the town center, which can be miles from the venue (35.0 vs 40.9 mi on one
// audited quote). PURE: no I/O.

/** True when the address has no house number (only a town, state or ZIP), so a geocode lands on the town
 *  center rather than the venue. ZIP codes are ignored when looking for the house number. */
export function looksCityLevel(address: string): boolean {
  const a = (address ?? "").replace(/\b\d{5}(?:-\d{4})?\b/g, " ");
  return !/\b\d+[A-Za-z]?\s+[A-Za-z]/.test(a);
}
