// Customer Intelligence (MVP6) — value, repeat, and win-back from the Goodshuffle BOOKINGS feed.
// Identity is the client email when present (stable), else name. Revenue (LTV) is real now that
// bookings carry contract totals.

import { todayInOpsTz } from "@/lib/dates";
import { getAllBookings } from "@/lib/db/repo";
import { aggregateCustomers, type CustomerAgg } from "./calc";

export interface CustomerOverview {
  today: string;
  customers: CustomerAgg[];
  total: number;
  repeatCount: number;
  repeatRate: number | null;
  totalRevenue: number | null; // sum of known customer revenue
  topByRevenue: CustomerAgg[];
  topByBookings: CustomerAgg[];
  dormant: CustomerAgg[];
  identityEmailBased: boolean; // true when at least one customer keyed by email (stable)
}

export function customerOverview(): CustomerOverview {
  const today = todayInOpsTz();
  const events = getAllBookings().map((b) => ({
    name: b.clientName || b.eventName,
    date: b.eventDate ?? "",
    email: b.clientEmail || undefined,
    revenue: b.grandTotal,
  }));
  const customers = aggregateCustomers(events, today);
  const total = customers.length;
  const repeatCount = customers.filter((c) => c.repeat).length;
  // Dormant, HIGHEST-VALUE first — a lapsed $20k client should top a lapsed 2×$300 one.
  const dormant = customers.filter((c) => c.status === "dormant").sort((a, b) => (b.totalRevenue ?? 0) - (a.totalRevenue ?? 0) || b.bookings - a.bookings);
  const revVals = customers.map((c) => c.totalRevenue).filter((v): v is number => v != null);
  return {
    today,
    customers,
    total,
    repeatCount,
    repeatRate: total > 0 ? repeatCount / total : null,
    totalRevenue: revVals.length > 0 ? revVals.reduce((s, v) => s + v, 0) : null,
    topByRevenue: [...customers].sort((a, b) => (b.totalRevenue ?? 0) - (a.totalRevenue ?? 0)).slice(0, 12),
    topByBookings: customers.slice(0, 12),
    dormant,
    identityEmailBased: customers.some((c) => c.key.startsWith("em:")),
  };
}
