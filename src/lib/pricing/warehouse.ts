// The Zoe Event Rentals warehouse — the fixed origin for every delivery leg. Coordinates are hardcoded
// because the origin never moves and a suite-numbered address ("#4A") trips keyless geocoders, so only
// the venue needs geocoding and the warehouse leg can never silently fail. Shared by the distance API
// (one-way miles) and the route-aware optimizer (incremental insertion against the warehouse endpoints).

import type { LatLng } from "@/lib/eta/geo";

export const WAREHOUSE_ADDRESS = "12712 Rock Creek Mill Rd #4A, North Bethesda, MD 20852";
export const WAREHOUSE_COORDS: LatLng = { lat: 39.0638628, lng: -77.1127462 };

/** The departure every pricing lookup uses: the next Tuesday at 10:00 ET, a typical delivery morning.
 *  Fixed so the miles (and the route Google picks under usual traffic) don't change with the hour a rep
 *  clicks. A 9pm lookup would otherwise see empty roads and choose the shortest route, not the fastest. */
export function pricingDeparture(now: Date = new Date()): Date {
  const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d); // YYYY-MM-DD
  const etOffset = (d: Date) => {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
      .formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
    const m = name.match(/GMT([+-]\d+)/);
    return m ? Number(m[1]) : -5;
  };
  const [y, mo, da] = etYmd(now).split("-").map(Number);
  const today = new Date(Date.UTC(y, mo - 1, da));
  const ahead = ((2 - today.getUTCDay() + 7) % 7) || 7; // next Tuesday, never today
  const day = new Date(today.getTime() + ahead * 86_400_000);
  const guess = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 15)); // ~10:00 ET
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 10 - etOffset(guess)));
}
