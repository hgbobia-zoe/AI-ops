// Inventory intelligence — CONCURRENT DEMAND from booked line items. We can say how many of an item
// are booked to go out on the same day across all events; we CANNOT say "over-booked" because there
// is no owned-inventory master (that would infer ownership from bookings — forbidden). So the owned
// count / over-booking verdict is always INVENTORY CAPACITY UNVERIFIED until an owned master exists.

export interface ItemStop {
  date: string;
  eventId: string;
  items: { name: string; quantity?: number }[];
}

/** Normalize a free-text item title so near-duplicates aggregate ("40x60 Tent" ≈ "40X60  Tent"). */
export function normalizeItem(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface ItemPeak {
  name: string; // display (first casing seen)
  peakQty: number; // max quantity booked out on a single day
  peakDate: string;
  daysWithDemand: number;
}

/** For each item, the PEAK single-day concurrent quantity across upcoming events. An event's items
 *  count once (deduped by eventId per date). Sorted by peak demand desc. */
export function peakItemDemand(stops: ItemStop[]): ItemPeak[] {
  // date -> itemKey -> { qty, display, events:Set }
  const byDate = new Map<string, Map<string, { qty: number; display: string; events: Set<string> }>>();
  for (const s of stops) {
    const dm = byDate.get(s.date) ?? new Map();
    byDate.set(s.date, dm);
    for (const it of s.items) {
      const key = normalizeItem(it.name || "");
      if (!key) continue;
      const cur = dm.get(key) ?? { qty: 0, display: it.name.trim(), events: new Set<string>() };
      // Count an event's line once per date (delivery+pickup can't both land here, but be safe).
      const eventKey = s.eventId || `${s.date}:${key}`;
      if (!cur.events.has(eventKey)) {
        cur.qty += typeof it.quantity === "number" ? it.quantity : 0;
        cur.events.add(eventKey);
      }
      dm.set(key, cur);
    }
  }

  // Collapse to per-item peak.
  const peaks = new Map<string, ItemPeak>();
  for (const [date, dm] of byDate) {
    for (const [key, v] of dm) {
      const existing = peaks.get(key);
      if (!existing) {
        peaks.set(key, { name: v.display, peakQty: v.qty, peakDate: date, daysWithDemand: 1 });
      } else {
        existing.daysWithDemand++;
        if (v.qty > existing.peakQty) {
          existing.peakQty = v.qty;
          existing.peakDate = date;
        }
      }
    }
  }
  return [...peaks.values()].filter((p) => p.peakQty > 0).sort((a, b) => b.peakQty - a.peakQty);
}
