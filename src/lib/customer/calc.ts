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

export interface CustomerAgg {
  name: string; // display (first casing seen)
  key: string; // stable identity: email > contactId > normalized name
  bookings: number;
  firstSeen: string;
  lastSeen: string; // may be a FUTURE date (an upcoming booking)
  daysSinceLast: number | null; // negative = booking is in the future
  repeat: boolean; // >= 2 bookings
  status: CustomerStatus;
  totalRevenue: number | null; // sum of known booking revenue ($); null if none priced
}

/** Aggregate events into per-customer frequency + recency. Identity is the Goodshuffle
 *  contactID when present (stable), else the normalized name (approximate). `dormantDays` is the
 *  gap after which a repeat customer is considered lapsed (default 1 year — annual-event cadence). */
export function aggregateCustomers(
  events: { name: string; date: string; contactId?: string; email?: string; revenue?: number | null }[],
  today: string,
  dormantDays = 365,
): CustomerAgg[] {
  const map = new Map<string, { display: string; dates: string[]; revenue: number | null }>();
  for (const e of events) {
    // Stable identity: email first (bookings feed), then contact id, then normalized name.
    // Never invent a customer from nothing (no id/email AND blank name).
    const email = e.email ? normalizeName(e.email) : "";
    const key = email ? `em:${email}` : e.contactId ? `id:${e.contactId}` : normalizeName(e.name);
    if (!key || key === "em:" || key === "id:") continue;
    const cur = map.get(key);
    const rev = typeof e.revenue === "number" ? e.revenue : null;
    if (cur) {
      cur.dates.push(e.date);
      if (!cur.display && e.name.trim()) cur.display = e.name.trim();
      if (rev != null) cur.revenue = (cur.revenue ?? 0) + rev;
    } else {
      map.set(key, { display: e.name.trim(), dates: [e.date], revenue: rev });
    }
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

    out.push({ name: v.display || "(unnamed)", key, bookings, firstSeen, lastSeen, daysSinceLast, repeat, status, totalRevenue: v.revenue });
  }

  // Most-frequent first, then by revenue, then alphabetical.
  out.sort((a, b) => b.bookings - a.bookings || (b.totalRevenue ?? 0) - (a.totalRevenue ?? 0) || (a.name < b.name ? -1 : 1));
  return out;
}
