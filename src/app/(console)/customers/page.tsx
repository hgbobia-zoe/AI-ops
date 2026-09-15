// Customer Intelligence (MVP6) — Nocturne. Value, repeat, and win-back from the Goodshuffle bookings
// feed. Identity is the client email when present (stable); revenue (LTV) is real. Data unchanged.

import { customerOverview } from "@/lib/customer/service";
import type { CustomerAgg } from "@/lib/customer/calc";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const fmtDate = (ymd: string): string => {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

const STATUS_TONE: Record<string, string> = { active: "text-positive", "one-time": "text-meta", dormant: "text-attention" };

function ContactCell({ c }: { c: CustomerAgg }): React.JSX.Element {
  if (!c.email && !c.phone) return <span className="text-[12px] text-meta">—</span>;
  return (
    <div className="flex flex-col gap-0.5 text-[12px]">
      {c.email && <a href={`mailto:${c.email}`} className="truncate text-secondary-text hover:text-foreground hover:underline" title={c.email}>{c.email}</a>}
      {c.phone && <span className="tabular-nums text-meta">{c.phone}</span>}
    </div>
  );
}

export default async function CustomersPage(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const s = customerOverview();
  const topList = showMoney ? s.topByRevenue : s.topByBookings;
  const avg = showMoney && s.total && s.totalRevenue != null ? s.totalRevenue / s.total : null;

  const figures: Figure[] = [
    { label: "Customers", value: s.total },
    { label: "Repeat", value: s.repeatCount },
    { label: "Dormant", value: s.dormant.length, tone: s.dormant.length ? "attention" : "default" },
    ...(showMoney ? ([{ label: "Won revenue", value: money(s.totalRevenue), sep: true }, { label: "Avg / customer", value: money(avg) }] as Figure[]) : []),
  ];

  return (
    <main className="p-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Customers</h1>
          <p className="text-[12.5px] text-meta">Value, repeat business, and win-back candidates from Goodshuffle bookings.</p>
        </div>
        <FigureStrip figures={figures} />
      </header>

      {/* Win back — proven spenders with a lost quote */}
      {showMoney && s.winBackVips.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-1 text-[13px] font-medium uppercase tracking-[0.1em] text-attention">Win back · top customers with a lost quote</h2>
          <p className="mb-2 text-[12px] text-meta">They&apos;ve spent real money with Zoe, but a quote is sitting Lost in Goodshuffle — worth a personal follow-up.</p>
          <div className="overflow-x-auto border border-border">
            <table className={tableCls}>
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>Customer</th>
                  <th className={thCls}>Contact</th>
                  <th className={`${thCls} text-right`}>Won to date</th>
                  <th className={`${thCls} text-right`}>Lost quote(s)</th>
                  <th className={thCls}>Last</th>
                </tr>
              </thead>
              <tbody>
                {s.winBackVips.slice(0, 20).map((c) => (
                  <tr key={c.key} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
                    <td className="px-2.5 py-2.5 font-medium">{c.name}</td>
                    <td className="px-2.5 py-2.5"><ContactCell c={c} /></td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums text-positive">{money(c.totalRevenue)}</td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums text-attention">{money(c.lostValue)}{c.lostBookings > 1 ? ` · ${c.lostBookings}` : ""}</td>
                    <td className="px-2.5 py-2.5 text-meta">{fmtDate(c.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Big spenders */}
      <section className="mb-8">
        <h2 className="mb-1 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{showMoney ? "Big spenders" : "Top customers by bookings"}</h2>
        {topList.length === 0 ? (
          <p className="text-[13.5px] text-muted-foreground">No bookings yet — pull from Settings → Pull Routes.</p>
        ) : (
          <div className="overflow-x-auto border border-border">
            <table className={tableCls}>
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>Customer</th>
                  {showMoney && <th className={thCls}>Contact</th>}
                  {showMoney && <th className={`${thCls} text-right`}>Won revenue</th>}
                  <th className={`${thCls} text-right`}>Bookings</th>
                  <th className={thCls}>Last</th>
                  <th className={thCls}>Status</th>
                </tr>
              </thead>
              <tbody>
                {topList.map((c) => (
                  <tr key={c.key} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
                    <td className="px-2.5 py-2.5 font-medium">{c.name}</td>
                    {showMoney && <td className="px-2.5 py-2.5"><ContactCell c={c} /></td>}
                    {showMoney && <td className="px-2.5 py-2.5 text-right tabular-nums">{money(c.totalRevenue)}</td>}
                    <td className="px-2.5 py-2.5 text-right tabular-nums">{c.bookings}</td>
                    <td className="px-2.5 py-2.5 text-meta">{fmtDate(c.lastSeen)}</td>
                    <td className={`px-2.5 py-2.5 text-[11px] font-medium uppercase tracking-[0.08em] ${STATUS_TONE[c.status] ?? "text-meta"}`}>{c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-[12px] text-meta">
        {s.identityEmailBased ? "Customers are matched by email (stable)." : "Customers are matched by name until emails are pulled."} From Goodshuffle bookings — pull fresh data from Settings → Pull Routes.
      </p>
    </main>
  );
}
