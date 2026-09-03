// Customer Intelligence (MVP6) — repeat/frequency/recency from real booking history. Identity is
// name-based (approximate until the Goodshuffle renter id is captured) and customer $ value is
// DATA UNAVAILABLE until revenue is captured. Both caveats are shown so nothing is over-trusted.

import { Users, Repeat, Moon, AlertTriangle } from "lucide-react";
import { customerOverview } from "@/lib/customer/service";
import type { CustomerAgg } from "@/lib/customer/calc";

export const dynamic = "force-dynamic";

const pct = (n: number | null): string => (n == null ? "—" : `${Math.round(n * 100)}%`);
const fmtDate = (ymd: string): string => {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

function StatusPill({ c }: { c: CustomerAgg }): React.JSX.Element {
  const map: Record<string, string> = {
    active: "border-emerald-500/40 text-emerald-300",
    "one-time": "border-white/15 text-muted-foreground",
    dormant: "border-amber-500/40 text-amber-300",
  };
  return <span className={`border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${map[c.status]}`}>{c.status}</span>;
}

export default async function CustomersPage(): Promise<React.JSX.Element> {
  const s = customerOverview();

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Users className="size-7" /> Customer Intelligence
        </h1>
        <p className="text-sm text-muted-foreground">Repeat business and win-back candidates from booking history.</p>
      </header>

      <div className="mb-6 flex items-start gap-2.5 border border-white/10 bg-white/[0.02] p-3 text-[11px] text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Customers are matched by their Goodshuffle <b>contact id</b> when the event was pulled with it, otherwise by
          <b> name</b> (approximate — near-duplicates may split or merge). Per-customer <b>$ value</b> lights up as revenue
          is captured on the pull.
        </span>
      </div>

      {/* Scorecard */}
      <section className="mb-6 grid gap-3 md:grid-cols-3">
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Users className="size-4" /> Customers</div>
          <div className="text-3xl font-bold tabular-nums">{s.total}</div>
          <p className="mt-1 text-[11px] text-muted-foreground">Distinct names in booking history.</p>
        </div>
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Repeat className="size-4" /> Repeat customers</div>
          <div className="text-3xl font-bold tabular-nums">{s.repeatCount}</div>
          <p className="mt-1 text-[11px] text-muted-foreground">{pct(s.repeatRate)} of customers have booked 2+ times.</p>
        </div>
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Moon className="size-4" /> Dormant repeats</div>
          <div className="text-3xl font-bold tabular-nums">{s.dormant.length}</div>
          <p className="mt-1 text-[11px] text-muted-foreground">Repeat customers with no booking in 12+ months.</p>
        </div>
      </section>

      {/* Top by bookings */}
      <section className="mb-8 space-y-2">
        <h2 className="text-lg font-semibold">Top customers by bookings</h2>
        {s.topByBookings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No booking history yet.</p>
        ) : (
          <div className="overflow-x-auto border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5">Customer</th>
                  <th className="p-2.5 text-right">Bookings</th>
                  <th className="p-2.5">First</th>
                  <th className="p-2.5">Last</th>
                  <th className="p-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {s.topByBookings.map((c) => (
                  <tr key={c.key}>
                    <td className="p-2.5 font-medium">{c.name}</td>
                    <td className="p-2.5 text-right tabular-nums">{c.bookings}</td>
                    <td className="p-2.5 text-muted-foreground">{fmtDate(c.firstSeen)}</td>
                    <td className="p-2.5 text-muted-foreground">{fmtDate(c.lastSeen)}</td>
                    <td className="p-2.5"><StatusPill c={c} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Win-back */}
      {s.dormant.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Win-back candidates</h2>
          <p className="text-[11px] text-muted-foreground">Repeat customers who haven&apos;t booked in over a year.</p>
          <div className="overflow-x-auto border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5">Customer</th>
                  <th className="p-2.5 text-right">Past bookings</th>
                  <th className="p-2.5">Last booking</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {s.dormant.slice(0, 20).map((c) => (
                  <tr key={c.key}>
                    <td className="p-2.5 font-medium">{c.name}</td>
                    <td className="p-2.5 text-right tabular-nums">{c.bookings}</td>
                    <td className="p-2.5 text-muted-foreground">{fmtDate(c.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
