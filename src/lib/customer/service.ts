// Customer Intelligence (MVP6) — assembles name-based frequency/recency segments. Customer $
// value stays UNAVAILABLE until revenue is captured; identity is approximate until the renter id
// is captured. Both caveats are surfaced in the UI so no one over-trusts the numbers.

import { todayInOpsTz } from "@/lib/dates";
import { getCustomerEvents } from "@/lib/db/repo";
import { aggregateCustomers, type CustomerAgg } from "./calc";

export interface CustomerOverview {
  today: string;
  customers: CustomerAgg[];
  total: number;
  repeatCount: number;
  repeatRate: number | null; // fraction of customers with >= 2 bookings
  topByBookings: CustomerAgg[];
  dormant: CustomerAgg[]; // repeat customers past the dormant window
  valueAvailable: false; // $ value needs the revenue capture
}

export function customerOverview(): CustomerOverview {
  const today = todayInOpsTz();
  const customers = aggregateCustomers(getCustomerEvents(), today);
  const total = customers.length;
  const repeatCount = customers.filter((c) => c.repeat).length;
  const dormant = customers.filter((c) => c.status === "dormant");
  return {
    today,
    customers,
    total,
    repeatCount,
    repeatRate: total > 0 ? repeatCount / total : null,
    topByBookings: customers.slice(0, 12),
    dormant,
    valueAvailable: false,
  };
}
