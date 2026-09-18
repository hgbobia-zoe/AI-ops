// Opportunity Radar — relationship memory (§17). When a discovered entity (a company on a new
// opportunity) matches an existing Zoe customer/quote history, surface that context so the rep
// "re-engages an existing relationship" instead of cold-contacting. REUSES the Sales OS aggregation
// (aggregateCustomers identity key + outcomeOf) — no new customer store, no fabricated history.

import { getDb } from "@/lib/db";
import { getAllBookings } from "@/lib/db/repo";
import { outcomeOf } from "@/lib/salesos/lost";
import { aggregateCustomers, normalizeName, type CustomerAgg } from "@/lib/customer/calc";
import { todayInOpsTz } from "@/lib/dates";

export interface RelationshipMemo {
  matched: boolean;
  customer?: CustomerAgg;
  /** A short, factual recommended action derived from the history (never invented). */
  recommendedAction?: string;
}

interface CustomerIndex {
  byEmail: Map<string, CustomerAgg>;
  byName: Map<string, CustomerAgg>;
}

/** Build a name/email index of Zoe's customer history from bookings (recomputed; cheap enough). */
export function buildCustomerIndex(today: string = todayInOpsTz()): CustomerIndex {
  const events = getAllBookings().map((b) => ({
    name: b.clientName || b.eventName,
    date: b.eventDate ?? b.dateCreated ?? today,
    email: b.clientEmail || undefined,
    phone: b.clientPhone || undefined,
    revenue: b.grandTotal,
    outcome: outcomeOf(b),
  }));
  const aggs = aggregateCustomers(events, today);
  const byEmail = new Map<string, CustomerAgg>();
  const byName = new Map<string, CustomerAgg>();
  for (const a of aggs) {
    if (a.email) byEmail.set(normalizeName(a.email), a);
    byName.set(normalizeName(a.name), a);
  }
  return { byEmail, byName };
}

/** Match an entity to Zoe's customer history by email (stable) then normalized name. Returns a memo
 *  with the aggregate + a factual recommended action, or {matched:false} when there's no history. */
export function matchEntity(entity: { name: string; email?: string | null }, index: CustomerIndex): RelationshipMemo {
  const hit =
    (entity.email ? index.byEmail.get(normalizeName(entity.email)) : undefined) ??
    index.byName.get(normalizeName(entity.name));
  if (!hit) return { matched: false };

  let action = "Re-engage existing relationship";
  if (hit.hasLostQuote) action = "Win-back: previously quoted and lost — re-open the conversation";
  else if (hit.status === "dormant") action = "Reactivate a dormant customer";
  else if (hit.status === "active") action = "Warm relationship — lead with the existing partnership";

  return { matched: true, customer: hit, recommendedAction: action };
}

/** Stamp radar_entities with the Zoe customer identity key they match (so the board/alerts can flag an
 *  existing relationship without a live re-match). Idempotent; cheap (few entities). Returns count matched. */
export function enrichEntityMatches(today: string = todayInOpsTz()): number {
  const index = buildCustomerIndex(today);
  const db = getDb();
  const ents = db.prepare("SELECT id, name, email FROM radar_entities").all() as { id: string; name: string; email: string | null }[];
  const upd = db.prepare("UPDATE radar_entities SET matched_customer_key=? WHERE id=?");
  let n = 0;
  const tx = db.transaction(() => {
    for (const e of ents) {
      const m = matchEntity({ name: e.name, email: e.email }, index);
      if (m.matched && m.customer) { upd.run(m.customer.key, e.id); n++; }
    }
  });
  tx();
  return n;
}
