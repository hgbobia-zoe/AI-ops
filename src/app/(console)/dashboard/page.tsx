// Main dashboard — the platform's at-a-glance home. Pulls today's real state from every
// module (routes, exceptions, crew) and links into each blade.

import Link from "next/link";
import { Truck, ShieldAlert, Users, AlertTriangle, CheckCircle2, ArrowRight } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRouteForDate, getOpenExceptions } from "@/lib/db/repo";
import { getCrewForDate, connecteamConfigured } from "@/lib/connecteam";
import { todayInOpsTz, formatYmdLong } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const today = todayInOpsTz();
  const trucks = getActiveVehicles();
  const fleet = trucks.map((t) => ({ truck: t, route: getRouteForDate(t.truckId, today) }));
  const activeRoutes = fleet.filter((f) => f.route && f.route.status !== "done");
  const stops = fleet.flatMap((f) => f.route?.stops ?? []);
  const done = stops.filter((s) => s.state === "Completed" || s.state === "Returned").length;
  const exceptions = getOpenExceptions();

  const crew = connecteamConfigured() ? await getCrewForDate(today) : [];
  const crewPeople = new Set(crew.flatMap((s) => s.assignees.map((a) => a.userId))).size;
  const openShifts = crew.filter((s) => s.isOpen).length;

  return (
    <main className="mx-auto max-w-5xl p-5 pb-16 md:p-8">
      <AutoRefresh seconds={60} />

      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">{formatYmdLong(today)}</p>
      </header>

      {/* Stat row */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Active routes" value={activeRoutes.length} sub={`${trucks.length} trucks`} />
        <Stat label="Stops done" value={stops.length ? `${done}/${stops.length}` : "—"} sub="today" />
        <Stat
          label="Open exceptions"
          value={exceptions.length}
          sub={exceptions.length ? "need attention" : "all clear"}
          tone={exceptions.length ? "warn" : "ok"}
        />
        <Stat
          label="Crew today"
          value={connecteamConfigured() ? crewPeople : "—"}
          sub={connecteamConfigured() ? `${crew.length} shifts` : "not connected"}
        />
      </section>

      {/* Module cards */}
      <section className="mt-8 grid gap-4 md:grid-cols-3">
        <ModuleCard
          href="/dispatch"
          icon={<Truck className="size-5" />}
          title="Dispatch"
          body={
            activeRoutes.length
              ? `${activeRoutes.length} route${activeRoutes.length === 1 ? "" : "s"} in progress`
              : "No active routes"
          }
        />
        <ModuleCard
          href="/risk"
          icon={<ShieldAlert className="size-5" />}
          title="Event Risk"
          body={
            openShifts
              ? `${openShifts} open shift${openShifts === 1 ? "" : "s"} to fill`
              : connecteamConfigured()
                ? "Crew scheduled — no open shifts"
                : "Connect Connecteam"
          }
          tone={openShifts ? "warn" : "ok"}
        />
        <ModuleCard
          href="/risk"
          icon={<Users className="size-5" />}
          title="Crew"
          body={connecteamConfigured() ? `${crewPeople} on the schedule` : "not connected"}
        />
      </section>

      {/* Exceptions preview */}
      {exceptions.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
            <AlertTriangle className="size-4" /> Open exceptions
          </h2>
          <div className="space-y-2">
            {exceptions.slice(0, 4).map((x) => (
              <div
                key={x.exceptionId}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm"
              >
                <span className="font-medium">{x.truckId ?? "—"}</span> · {x.type}
                {x.reason ? <span className="text-muted-foreground"> — {x.reason}</span> : null}
              </div>
            ))}
          </div>
          <Link href="/dispatch" className="mt-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            View in Dispatch <ArrowRight className="size-3.5" />
          </Link>
        </section>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="surface rounded-2xl border border-white/5 p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-bold tabular-nums">{value}</div>
      {sub && (
        <div
          className={`mt-0.5 flex items-center gap-1 text-xs ${
            tone === "warn" ? "text-amber-400" : tone === "ok" ? "text-emerald-400" : "text-muted-foreground"
          }`}
        >
          {tone === "ok" && <CheckCircle2 className="size-3.5" />}
          {sub}
        </div>
      )}
    </div>
  );
}

function ModuleCard({
  href,
  icon,
  title,
  body,
  tone,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  tone?: "ok" | "warn";
}) {
  return (
    <Link
      href={href}
      className="surface group flex flex-col gap-3 rounded-2xl border border-white/5 p-5 transition-colors hover:border-white/15"
    >
      <span className="btn-hero flex size-10 items-center justify-center rounded-xl">{icon}</span>
      <div>
        <div className="flex items-center gap-1.5 font-semibold">
          {title}
          <ArrowRight className="size-4 opacity-0 transition-opacity group-hover:opacity-60" />
        </div>
        <div className={`text-sm ${tone === "warn" ? "text-amber-400" : "text-muted-foreground"}`}>{body}</div>
      </div>
    </Link>
  );
}
