// Staffing — the day-by-day crew roster: who's actually scheduled (Connecteam) against the
// day's routes. Prep/load the day before, drivers on the event day, unload & clean after a
// pickup, and office/other roles for awareness. Coverage PROBLEMS live on /risk (the queue);
// this blade is the "who's present" detail with day navigation.

import Link from "next/link";
import {
  Users,
  UserRound,
  Truck,
  PackageCheck,
  PackageOpen,
  Briefcase,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import {
  getCrewForDate,
  connecteamConfigured,
  type CrewShift,
  type CrewMember,
  type CrewRole,
} from "@/lib/connecteam";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRouteForDate } from "@/lib/db/repo";
import { crewForRoute } from "@/lib/crewRules";
import { todayInOpsTz, shiftYmd, formatYmdLong, formatClockTime } from "@/lib/dates";
import type { Route } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function StaffingPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const today = todayInOpsTz();
  const date = sp?.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const dayBefore = shiftYmd(date, -1);
  const nextDay = shiftYmd(date, 1);
  const isToday = date === today;

  const trucks = getActiveVehicles();
  const routes = trucks
    .map((t) => getRouteForDate(t.truckId, date))
    .filter((r): r is Route => Boolean(r) && r!.status !== "done");

  const configured = connecteamConfigured();
  const [crewD, crewPrev, crewNext] = configured
    ? await Promise.all([getCrewForDate(date), getCrewForDate(dayBefore), getCrewForDate(nextDay)])
    : [[], [], []];

  const driversD = distinctByRole(crewD, "driver");
  const prepPrev = distinctByRole(crewPrev, "prep");
  const officeD = distinctByRole(crewD, "other");
  const hasPickups = routes.some((r) => r.stops.some((s) => s.kind === "pickup"));
  const routeEndUnix = latestStopUnix(routes);
  const unloadCrew = dedupById([...distinctPrepAfter(crewD, routeEndUnix), ...distinctByRole(crewNext, "prep")]);

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      {isToday && <AutoRefresh seconds={60} />}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <Users className="size-7" /> Staffing
          </h1>
          <p className="text-sm text-muted-foreground">
            {driversD.length} driver{driversD.length === 1 ? "" : "s"} · {prepPrev.length} prep (day before) ·{" "}
            {routes.length} route{routes.length === 1 ? "" : "s"}
          </p>
        </div>
        <DateNav date={date} today={today} />
      </header>

      {!configured && (
        <div className="mb-6 border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          Connecteam isn&apos;t connected — no crew data to show.
        </div>
      )}

      <RoleSection
        icon={<PackageCheck className="size-4" />}
        title="Prep & load"
        when={`Day before · ${formatYmdLong(dayBefore)}`}
        crew={prepPrev}
        emptyText={configured ? "No warehouse / asset crew scheduled the day before." : "Connecteam not connected."}
      />

      <RoleSection
        icon={<Truck className="size-4" />}
        title="Drivers"
        when={`Event day · ${isToday ? "Today" : formatYmdLong(date)}`}
        crew={driversD}
        emptyText={configured ? "No driver scheduled." : "Connecteam not connected."}
      />

      {hasPickups && (
        <RoleSection
          icon={<PackageOpen className="size-4" />}
          title="Unload & clean"
          when={routeEndUnix ? `After pickup · trucks back ~${formatClockTime(new Date(routeEndUnix * 1000).toISOString())}` : "After pickup"}
          crew={unloadCrew}
          emptyText={configured ? `No one scheduled to unload — add a same-day evening or next-day (${formatYmdLong(nextDay)}) shift.` : "Connecteam not connected."}
        />
      )}

      {officeD.length > 0 && (
        <RoleSection
          icon={<Briefcase className="size-4" />}
          title="Also on the schedule"
          when="For awareness"
          crew={officeD}
          emptyText=""
        />
      )}

      {/* Routes + crew each needs (tent rules) */}
      <section className="mb-2 space-y-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Truck className="size-4" /> Routes &amp; crew needed
        </h2>
        {routes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active routes for {isToday ? "today" : formatYmdLong(date)}.</p>
        ) : (
          routes.map((r) => {
            const need = crewForRoute(r.stops.map((s) => s.items ?? []));
            const first = earliestStopOfRoute(r);
            return (
              <div key={r.routeId} className="surface flex flex-wrap items-center justify-between gap-3 border border-white/5 p-3">
                <div className="flex items-center gap-2.5">
                  <span className="btn-hero flex size-8 items-center justify-center">
                    <Truck className="size-4" />
                  </span>
                  <div>
                    <div className="font-medium">
                      {r.truckId}
                      {r.driverName ? ` · ${r.driverName}` : ""}
                    </div>
                    <div className="text-xs text-muted-foreground">{r.stops.length} stops</div>
                  </div>
                </div>
                <div className="flex items-center gap-5">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Crew needed</div>
                    <div className="flex items-center gap-1.5 font-semibold tabular-nums">
                      {need.crew}
                      {need.hasTent && (
                        <span className="bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-black">
                          {need.reasons[need.reasons.length - 1] ?? "tent"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">First stop</div>
                    <div className="font-semibold tabular-nums">{first ? formatClockTime(first) : "—"}</div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </section>
    </main>
  );
}

function distinctByRole(shifts: CrewShift[], role: CrewRole): CrewMember[] {
  const m = new Map<number, CrewMember>();
  for (const s of shifts) for (const a of s.assignees) if (a.role === role) m.set(a.userId, a);
  return [...m.values()];
}
function distinctPrepAfter(shifts: CrewShift[], routeEndUnix: number | null): CrewMember[] {
  const m = new Map<number, CrewMember>();
  for (const s of shifts) {
    if (routeEndUnix != null && s.endUnix < routeEndUnix) continue;
    for (const a of s.assignees) if (a.role === "prep") m.set(a.userId, a);
  }
  return [...m.values()];
}
function dedupById(members: CrewMember[]): CrewMember[] {
  const m = new Map<number, CrewMember>();
  for (const x of members) m.set(x.userId, x);
  return [...m.values()];
}
function latestStopUnix(routes: Route[]): number | null {
  let best = -Infinity;
  for (const r of routes)
    for (const s of r.stops) {
      const raw = s.plannedWindow || s.eta;
      if (!raw) continue;
      const t = Date.parse(raw);
      if (!Number.isNaN(t)) best = Math.max(best, t);
    }
  return best === -Infinity ? null : Math.floor(best / 1000);
}
function earliestStopOfRoute(r: Route): string | null {
  let best: string | null = null;
  let bestT = Infinity;
  for (const s of r.stops) {
    const raw = s.plannedWindow || s.eta;
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isNaN(t) || t >= bestT) continue;
    bestT = t;
    best = raw;
  }
  return best;
}

function RoleSection({
  icon,
  title,
  when,
  crew,
  emptyText,
}: {
  icon: React.ReactNode;
  title: string;
  when: string;
  crew: CrewMember[];
  emptyText: string;
}): React.JSX.Element {
  return (
    <section className="mb-8 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          {icon} {title}
        </h2>
        <span className="text-xs text-muted-foreground">{when}</span>
      </div>
      {crew.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {crew.map((c) => (
            <span key={c.userId} className="inline-flex items-center gap-1.5 border border-white/10 bg-white/5 px-2.5 py-1 text-sm">
              <UserRound className="size-3.5 text-muted-foreground" />
              {c.name}
              {c.title && <span className="text-[11px] text-muted-foreground">· {c.title}</span>}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function DateNav({ date, today }: { date: string; today: string }): React.JSX.Element {
  const prev = shiftYmd(date, -1);
  const next = shiftYmd(date, 1);
  const isToday = date === today;
  const href = (d: string) => (d === today ? "/staffing" : `/staffing?date=${d}`);
  return (
    <div className="flex items-center gap-1.5">
      <Link href={href(prev)} aria-label="Previous day" className="flex size-9 items-center justify-center border border-white/10 text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" />
      </Link>
      <span className="inline-flex items-center gap-2 border border-white/10 px-3 py-1.5 text-sm font-medium">
        <CalendarDays className="size-4 text-muted-foreground" />
        {isToday ? "Today" : formatYmdLong(date)}
      </span>
      <Link href={href(next)} aria-label="Next day" className="flex size-9 items-center justify-center border border-white/10 text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-4" />
      </Link>
    </div>
  );
}
