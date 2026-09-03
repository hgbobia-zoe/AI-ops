// Command center — the 60-second "what do I need to know?" home. Surfaces the ranked management
// attention feed the Ops Manager computes, plus one number per module. Money is Owner/Admin only.

import Link from "next/link";
import { Truck, AlertTriangle, ArrowRight, DollarSign, TrendingUp, Users, Radar, Download } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRouteForDate, getOpenExceptions } from "@/lib/db/repo";
import { opsOverview } from "@/lib/ops/service";
import { salesOverview } from "@/lib/sales/service";
import { customerOverview } from "@/lib/customer/service";
import { getPullState } from "@/lib/pull/state";
import { todayInOpsTz, formatYmdLong } from "@/lib/dates";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import type { Priority } from "@/lib/ops/manager";

export const dynamic = "force-dynamic";

const money = (n: number | null | undefined): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const P_TONE: Record<Priority, string> = { critical: "border-l-red-500", high: "border-l-orange-500", medium: "border-l-amber-500", info: "border-l-white/20" };

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const today = todayInOpsTz();

  const trucks = getActiveVehicles();
  const fleet = trucks.map((t) => getRouteForDate(t.truckId, today));
  const activeRoutes = fleet.filter((r) => r && r.status !== "done").length;
  const stops = fleet.flatMap((r) => r?.stops ?? []);
  const done = stops.filter((s) => s.state === "Completed" || s.state === "Returned").length;
  const exceptions = getOpenExceptions();

  const o = await opsOverview();
  const attention = (showMoney ? o.items : o.items.filter((i) => i.source !== "finance")).slice(0, 5);
  const sales = salesOverview(8);
  const custs = customerOverview();
  const pull = getPullState();
  const routeAts = Object.entries(pull.sources ?? {}).filter(([k]) => k.startsWith("route:")).map(([, v]) => Date.parse(v.at));
  const routesAgeH = routeAts.length ? Math.round((Date.now() - Math.max(...routeAts)) / 3_600_000) : null;

  return (
    <main className="mx-auto max-w-5xl p-5 pb-16 md:p-8">
      <AutoRefresh seconds={120} />
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">{formatYmdLong(today)}</p>
      </header>

      {/* Management attention — the whole point */}
      <section className="mb-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Radar className="size-4" /> Needs attention</h2>
          <Link href="/ops" className="text-xs text-muted-foreground hover:text-foreground">Ops Manager →</Link>
        </div>
        {attention.length === 0 ? (
          <div className="border border-emerald-500/30 bg-emerald-500/[0.06] p-4 text-sm text-emerald-200">All clear — nothing needs attention right now.</div>
        ) : (
          <div className="space-y-1.5">
            {attention.map((i) => (
              <Link key={i.key} href={i.href} className={`flex items-center justify-between gap-3 border border-l-2 border-white/10 bg-white/[0.02] px-3 py-2 text-sm hover:bg-white/[0.05] ${P_TONE[i.priority]}`}>
                <span className="min-w-0 flex-1 truncate">{i.title}</span>
                {i.daysUntil != null && <span className="shrink-0 text-[11px] text-muted-foreground">{i.daysUntil <= 0 ? "today" : `in ${i.daysUntil}d`}</span>}
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* One number per module */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile href="/dispatch" icon={<Truck className="size-4" />} label="Active routes" value={activeRoutes} sub={stops.length ? `${done}/${stops.length} stops done` : `${trucks.length} trucks`} />
        <Tile href="/dispatch" icon={<AlertTriangle className="size-4" />} label="Exceptions" value={exceptions.length} sub={exceptions.length ? "need attention" : "all clear"} warn={exceptions.length > 0} />
        <Tile href="/sales" icon={<TrendingUp className="size-4" />} label="Booked (8wk)" value={sales.totalBooked} sub={showMoney ? `${money(sales.totalRevenue)} pipeline` : "events"} />
        <Tile href="/customers" icon={<Users className="size-4" />} label="Customers" value={custs.total} sub={`${custs.repeatCount} repeat · ${custs.dormant.length} dormant`} />
      </section>

      {/* Money — Owner/Admin only */}
      {showMoney && o.finance && (
        <section className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile href="/finance" icon={<DollarSign className="size-4" />} label="Revenue (wk)" value={money(o.finance.revenue.signed)} sub={o.finance.revenue.target ? `target ${money(o.finance.revenue.target)}` : "signed"} />
          <Tile href="/finance" icon={<DollarSign className="size-4" />} label="Labor (wk)" value={money(o.finance.labor.actualCost ?? o.finance.labor.plannedCost)} sub={o.finance.labor.actualCost == null ? "planned" : "actual"} />
          <Tile href="/finance" icon={<DollarSign className="size-4" />} label="Contribution" value={money(o.finance.contribution.value)} sub={o.finance.contribution.value == null ? "needs labor" : "signed − labor"} />
          <Tile href="/admin/pull" icon={<Download className="size-4" />} label="Data freshness" value={routesAgeH == null ? "—" : `${routesAgeH}h`} sub="since last route pull" warn={routesAgeH != null && routesAgeH >= 26} />
        </section>
      )}
    </main>
  );
}

function Tile({ href, icon, label, value, sub, warn }: { href: string; icon: React.ReactNode; label: string; value: string | number; sub?: string; warn?: boolean }): React.JSX.Element {
  return (
    <Link href={href} className="surface rounded-2xl border border-white/5 p-4 transition-colors hover:border-white/15">
      <div className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">{icon} {label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className={`mt-0.5 text-xs ${warn ? "text-amber-400" : "text-muted-foreground"}`}>{sub}</div>}
    </Link>
  );
}
