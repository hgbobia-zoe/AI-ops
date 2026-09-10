// Customer Intelligence (MVP6) — pure customer aggregation from booking history. Identity is
// NAME-BASED (approximate) until the Goodshuffle renter id is captured; the UI flags this.
// Monetary value / LTV needs revenue (a deferred capture), so this module never touches money —
// it derives real frequency and recency from event dates only.

/** Collapse whitespace + case so "Jane  Doe" and "jane doe" aggregate together. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export type CustomerStatus = "active" | "one-time" | "dormant";
export type BookingOutcome = "won" | "lost" | "open";

export interface CustomerAgg {
  name: string; // display (first casing seen)
  key: string; // stable identity: email > contactId > normalized name
  email: string | null;
  phone: string | null;
  bookings: number; // all bookings (won + lost + open)
  wonBookings: number;
  lostBookings: number; // quotes currently marked Lost/Cancelled
  firstSeen: string;
  lastSeen: string; // may be a FUTURE date (an upcoming booking)
  daysSinceLast: number | null; // negative = booking is in the future
  repeat: boolean; // >= 2 bookings
  status: CustomerStatus;
  // Money splits ACTUAL spend from quoted-but-lost — a lost quote is NOT revenue. `totalRevenue`
  // (= wonRevenue) is the number to rank "top customers" by; lostValue is opportunity, not income.
  totalRevenue: number | null; // = wonRevenue (sum of WON booking $); null if none won-and-priced
  lostValue: number | null; // sum of $ on this customer's lost quotes
  hasLostQuote: boolean;
}

/** Aggregate events into per-customer frequency, recency, and money. Identity is the client email when
 *  present (stable), else contactID, else normalized name. Revenue is split by OUTCOME so a lost quote
 *  never counts as spend. `dormantDays` = gap after which a repeat customer is lapsed (default 1 year). */
export function aggregateCustomers(
  events: { name: string; date: string; contactId?: string; email?: string; phone?: string; revenue?: number | null; outcome?: BookingOutcome }[],
  today: string,
  dormantDays = 365,
): CustomerAgg[] {
  interface Acc { display: string; email: string | null; phone: string | null; dates: string[]; won: number | null; lost: number | null; wonN: number; lostN: number }
  const map = new Map<string, Acc>();
  for (const e of events) {
    const email = e.email ? normalizeName(e.email) : "";
    const key = email ? `em:${email}` : e.contactId ? `id:${e.contactId}` : normalizeName(e.name);
    if (!key || key === "em:" || key === "id:") continue;
    const rev = typeof e.revenue === "number" ? e.revenue : null;
    const outcome = e.outcome ?? "open";
    let cur = map.get(key);
    if (!cur) {
      cur = { display: e.name.trim(), email: e.email || null, phone: e.phone || null, dates: [], won: null, lost: null, wonN: 0, lostN: 0 };
      map.set(key, cur);
    }
    cur.dates.push(e.date);
    if (!cur.display && e.name.trim()) cur.display = e.name.trim();
    if (!cur.email && e.email) cur.email = e.email;
    if (!cur.phone && e.phone) cur.phone = e.phone;
    if (outcome === "won") { cur.wonN++; if (rev != null) cur.won = (cur.won ?? 0) + rev; }
    else if (outcome === "lost") { cur.lostN++; if (rev != null) cur.lost = (cur.lost ?? 0) + rev; }
  }

  const out: CustomerAgg[] = [];
  for (const [key, v] of map) {
    const dates = v.dates.filter(Boolean).sort();
    const firstSeen = dates[0] ?? "";
    const lastSeen = dates[dates.length - 1] ?? "";
    const bookings = v.dates.length;
    const repeat = bookings >= 2;
    const daysSinceLast = lastSeen ? daysBetween(lastSeen, today) : null;

    let status: CustomerStatus;
    if (daysSinceLast != null && daysSinceLast < 0) status = "active"; // has a future booking
    else if (!repeat) status = "one-time";
    else if (daysSinceLast != null && daysSinceLast > dormantDays) status = "dormant";
    else status = "active";

    out.push({
      name: v.display || "(unnamed)",
      key,
      email: v.email,
      phone: v.phone,
      bookings,
      wonBookings: v.wonN,
      lostBookings: v.lostN,
      firstSeen,
      lastSeen,
      daysSinceLast,
      repeat,
      status,
      totalRevenue: v.won,
      lostValue: v.lost,
      hasLostQuote: v.lostN > 0,
    });
  }

  // Most-frequent first, then by WON revenue, then alphabetical.
  out.sort((a, b) => b.bookings - a.bookings || (b.totalRevenue ?? 0) - (a.totalRevenue ?? 0) || (a.name < b.name ? -1 : 1));
  return out;
}
