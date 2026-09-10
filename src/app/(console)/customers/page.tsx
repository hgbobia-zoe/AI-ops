// Customer Intelligence (MVP6) — value, repeat, and win-back from the Goodshuffle bookings feed.
// Identity is the client email when present (stable); revenue (LTV) is real.

import { Users, Repeat, DollarSign, Moon } from "lucide-react";
import { customerOverview } from "@/lib/customer/service";
import type { CustomerAgg } from "@/lib/customer/calc";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const pct = (n: number | null): string => (n == null ? "—" : `${Math.round(n * 100)}%`);
const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
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

/** Contact affordance for marketing outreach — email (mailto) + phone, or a hint when unknown. */
function ContactCell({ c }: { c: CustomerAgg }): React.JSX.Element {
  if (!c.email && !c.phone) return <span className="text-[11px] text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-0.5 text-[11px]">
      {c.email && (
        <a href={`mailto:${c.email}`} className="text-sky-300/90 hover:text-sky-200 hover:underline">{c.email}</a>
      )}
      {c.phone && <span className="tabular-nums text-muted-foreground">{c.phone}</span>}
    </div>
  );
}

export default async function CustomersPage(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const s = customerOverview();
  const topList = showMoney ? s.topByRevenue : s.topByBookings;

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Users className="size-7" /> Customer Intelligence
        </h1>
        <p className="text-sm text-muted-foreground">Value, repeat business, and win-back candidates from Goodshuffle bookings.</p>
      </header>

      {/* Scorecard */}
      <section className={`mb-6 grid gap-3 ${showMoney ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Users className="size-4" /> Customers</div>
          <div className="text-3xl font-bold tabular-nums">{s.total}</div>
        </div>
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Repeat className="size-4" /> Repeat</div>
          <div className="text-3xl font-bold tabular-nums">{s.repeatCount}</div>
          <p className="mt-1 text-[11px] text-muted-foreground">{pct(s.repeatRate)} of customers</p>
        </div>
        {showMoney && (
          <div className="surface border border-white/5 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><DollarSign className="size-4" /> Revenue</div>
            <div className="text-2xl font-bold tabular-nums">{money(s.totalRevenue)}</div>
            <p className="mt-1 text-[11px] text-muted-foreground">won business (lost quotes excluded)</p>
          </div>
        )}
        <div className="surface border border-white/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Moon className="size-4" /> Dormant</div>
          <div className="text-3xl font-bold tabular-nums">{s.dormant.length}</div>
          <p className="mt-1 text-[11px] text-muted-foreground">repeat, quiet 12+ mo</p>
        </div>
      </section>

      {/* Win-back VIPs — proven spenders with a quote currently marked LOST (the #1 flag) */}
      {showMoney && s.winBackVips.length > 0 && (
        <section className="mb-8 space-y-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><DollarSign className="size-5 text-amber-300" /> Win back — top customers with a lost quote</h2>
          <p className="text-[11px] text-muted-foreground">
            They&apos;ve spent real money with Zoe, but a quote is sitting <b>Lost</b> in Goodshuffle. Worth a personal follow-up before writing it off.
          </p>
          <div className="overflow-x-auto border border-amber-500/30">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5">Customer</th>
                  <th className="p-2.5">Contact</th>
                  <th className="p-2.5 text-right">Won to date</th>
                  <th className="p-2.5 text-right">Lost quote(s)</th>
                  <th className="p-2.5">Last</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {s.winBackVips.slice(0, 20).map((c) => (
                  <tr key={c.key}>
                    <td className="p-2.5 font-medium">{c.name}</td>
                    <td className="p-2.5"><ContactCell c={c} /></td>
                    <td className="p-2.5 text-right tabular-nums text-emerald-300">{money(c.totalRevenue)}</td>
                    <td className="p-2.5 text-right tabular-nums text-amber-300">{money(c.lostValue)}{c.lostBookings > 1 ? ` · ${c.lostBookings}` : ""}</td>
                    <td className="p-2.5 text-muted-foreground">{fmtDate(c.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Big spenders — the marketing list */}
      <section className="mb-8 space-y-2">
        <h2 className="text-lg font-semibold">{showMoney ? "Big spenders" : "Top customers by bookings"}</h2>
        <p className="text-[11px] text-muted-foreground">
          {showMoney ? "Your best customers by actual (won) revenue — reach out for repeat business and referrals." : "Your most frequent customers."}
        </p>
        {topList.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bookings yet — pull from Settings → Pull Routes.</p>
        ) : (
          <div className="overflow-x-auto border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5">Customer</th>
                  {showMoney && <th className="p-2.5">Contact</th>}
                  {showMoney && <th className="p-2.5 text-right">Won revenue</th>}
                  <th className="p-2.5 text-right">Bookings</th>
                  <th className="p-2.5">Last</th>
                  <th className="p-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {topList.map((c) => (
                  <tr key={c.key}>
                    <td className="p-2.5 font-medium">{c.name}</td>
                    {showMoney && <td className="p-2.5"><ContactCell c={c} /></td>}
                    {showMoney && <td className="p-2.5 text-right tabular-nums">{money(c.totalRevenue)}</td>}
                    <td className="p-2.5 text-right tabular-nums">{c.bookings}</td>
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
                  {showMoney && <th className="p-2.5 text-right">Past revenue</th>}
                  <th className="p-2.5 text-right">Bookings</th>
                  <th className="p-2.5">Last booking</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {s.dormant.slice(0, 20).map((c) => (
                  <tr key={c.key}>
                    <td className="p-2.5 font-medium">{c.name}</td>
                    {showMoney && <td className="p-2.5 text-right tabular-nums">{money(c.totalRevenue)}</td>}
                    <td className="p-2.5 text-right tabular-nums">{c.bookings}</td>
                    <td className="p-2.5 text-muted-foreground">{fmtDate(c.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="mt-6 text-[11px] text-muted-foreground">
        {s.identityEmailBased ? "Customers are matched by email (stable)." : "Customers are matched by name until emails are pulled."}{" "}
        From Goodshuffle bookings. Pull fresh data from Settings → Pull Routes.
      </p>
    </main>
  );
}
