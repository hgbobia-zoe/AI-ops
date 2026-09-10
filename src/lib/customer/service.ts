// Customer Intelligence (MVP6) — value, repeat, and win-back from the Goodshuffle BOOKINGS feed.
// Identity is the client email when present (stable), else name. Revenue (LTV) is real now that
// bookings carry contract totals.

import { todayInOpsTz } from "@/lib/dates";
import { getAllBookings } from "@/lib/db/repo";
import { outcomeOf } from "@/lib/salesos/lost";
import { aggregateCustomers, type CustomerAgg } from "./calc";

export interface CustomerOverview {
  today: string;
  customers: CustomerAgg[];
  total: number;
  repeatCount: number;
  repeatRate: number | null;
  totalRevenue: number | null; // sum of WON customer revenue (actual spend)
  topByRevenue: CustomerAgg[]; // big spenders — ranked by WON revenue only
  topByBookings: CustomerAgg[];
  dormant: CustomerAgg[];
  winBackVips: CustomerAgg[]; // proven spenders who have a quote currently marked lost — win it back
  identityEmailBased: boolean; // true when at least one customer keyed by email (stable)
}

export function customerOverview(): CustomerOverview {
  const today = todayInOpsTz();
  const events = getAllBookings().map((b) => ({
    name: b.clientName || b.eventName,
    date: b.eventDate ?? "",
    email: b.clientEmail || undefined,
    phone: b.clientPhone || undefined,
    revenue: b.grandTotal,
    // Only WON bookings count as revenue; a lost quote is opportunity, not spend. This is what stops a
    // customer with big LOST quotes from ranking as a "top customer by revenue".
    outcome: outcomeOf({ signed: b.signed, statusLabel: b.statusLabel }),
  }));
  const customers = aggregateCustomers(events, today);
  const total = customers.length;
  const repeatCount = customers.filter((c) => c.repeat).length;
  // Dormant, HIGHEST-VALUE first — a lapsed $20k client should top a lapsed 2×$300 one.
  const dormant = customers.filter((c) => c.status === "dormant").sort((a, b) => (b.totalRevenue ?? 0) - (a.totalRevenue ?? 0) || b.bookings - a.bookings);
  const byWon = (a: CustomerAgg, b: CustomerAgg): number => (b.totalRevenue ?? 0) - (a.totalRevenue ?? 0);
  const revVals = customers.map((c) => c.totalRevenue).filter((v): v is number => v != null);
  // Win-back VIPs: they've actually spent money with us AND have a quote sitting Lost right now.
  const winBackVips = customers.filter((c) => (c.totalRevenue ?? 0) > 0 && c.hasLostQuote).sort(byWon);
  return {
    today,
    customers,
    total,
    repeatCount,
    repeatRate: total > 0 ? repeatCount / total : null,
    totalRevenue: revVals.length > 0 ? revVals.reduce((s, v) => s + v, 0) : null,
    topByRevenue: [...customers].filter((c) => (c.totalRevenue ?? 0) > 0).sort(byWon).slice(0, 20),
    topByBookings: customers.slice(0, 12),
    dormant,
    winBackVips,
    identityEmailBased: customers.some((c) => c.key.startsWith("em:")),
  };
}
