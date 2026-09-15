// Staffing — the day-by-day crew roster: who's actually scheduled (Connecteam) against the
// day's routes. Prep/load the day before, drivers on the event day, unload & clean after a
// pickup, and office/other roles for awareness. Coverage PROBLEMS live on /risk (the queue);
// this blade is the "who's present" detail with day navigation.

import Link from "next/link";
import { Truck, PackageCheck, PackageOpen, Briefcase, ChevronLeft, ChevronRight } from "lucide-react";
import { DatePicker } from "@/components/DatePicker";
import { AutoRefresh } from "@/components/AutoRefresh";
import {
  getCrewForDate,
  getCrewForDateSafe,
  getUsersList,
  connecteamConfigured,
  type CrewShift,
  type CrewMember,
  type CrewRole,
} from "@/lib/connecteam";
import { openShiftsWithSuggestions } from "@/lib/staffing/openShifts";
import { OpenShiftsPanel } from "@/components/OpenShiftsPanel";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRouteForDate } from "@/lib/db/repo";
import { crewForRoute } from "@/lib/crewRules";
import { todayInOpsTz, shiftYmd, formatYmdLong, formatClockTime } from "@/lib/dates";
import type { Route } from "@/lib/types";
import { FigureStrip, type Figure } from "@/components/console-primitives";

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
  const [crewDResult, crewPrev, crewNext, usersList] = configured
    ? await Promise.all([getCrewForDateSafe(date), getCrewForDate(dayBefore), getCrewForDate(nextDay), getUsersList()])
    : [{ ok: false, shifts: [] }, [] as CrewShift[], [] as CrewShift[], [] as CrewMember[]];
  const crewD = crewDResult.shifts;
  // Open (unassigned) shifts on the day + who's free to take them (schedule-derived, not fabricated).
  const openShifts = openShiftsWithSuggestions(crewD, usersList);

  const driversD = distinctByRole(crewD, "driver");
  const prepPrev = distinctByRole(crewPrev, "prep");
  const officeD = distinctByRole(crewD, "other");
  const hasPickups = routes.some((r) => r.stops.some((s) => s.kind === "pickup"));
  const routeEndUnix = latestStopUnix(routes);
  const unloadCrew = dedupById([...distinctPrepAfter(crewD, routeEndUnix), ...distinctByRole(crewNext, "prep")]);

  const figures: Figure[] = [
    { label: "Drivers", value: `${driversD.length}/${routes.length}`, tone: driversD.length < routes.length ? "critical" : "default" },
    { label: "Prep", value: prepPrev.length },
    ...(hasPickups ? ([{ label: "Unload", value: unloadCrew.length, tone: unloadCrew.length === 0 ? "attention" : "default" }] as Figure[]) : []),
    { label: "Office", value: officeD.length },
    { label: "Open shift", value: openShifts.length, tone: openShifts.length ? "critical" : "default", sep: true },
  ];

  return (
    <main className="p-6">
      {isToday && <AutoRefresh seconds={60} />}
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Staffing</h1>
          <p className="text-[12.5px] text-meta">{formatYmdLong(date)} · {routes.length} route{routes.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex items-end gap-6">
          <FigureStrip figures={figures} />
          <DateNav date={date} today={today} />
        </div>
      </header>

      {!configured && <p className="mb-6 text-[12.5px] text-attention">Connecteam isn&apos;t connected — no crew data to show.</p>}

      {/* Open shifts (scheduled but unassigned) + suggested crew — top of the page so gaps are seen first. */}
      <OpenShiftsPanel openShifts={openShifts} verified={crewDResult.ok} />

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
      <section className="mb-2">
        <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Routes &amp; crew needed</h2>
        {routes.length === 0 ? (
          <p className="text-[13px] text-meta">No active routes for {isToday ? "today" : formatYmdLong(date)}.</p>
        ) : (
          <div className="border border-border">
            {routes.map((r) => {
              const need = crewForRoute(r.stops.map((s) => s.items ?? []));
              const first = earliestStopOfRoute(r);
              return (
                <div key={r.routeId} className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 first:border-t-0">
                  <div>
                    <div className="text-[14px] font-medium">{r.truckId}{r.driverName ? ` · ${r.driverName}` : ""}</div>
                    <div className="text-[12px] text-meta">{r.stops.length} stops</div>
                  </div>
                  <div className="flex items-center gap-6">
                    <div>
                      <div className="text-[10.5px] uppercase tracking-[0.1em] text-meta">Crew needed</div>
                      <div className="flex items-center gap-1.5 text-[15px] font-medium tabular-nums">
                        {need.crew}
                        {need.hasTent && <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-attention">{need.reasons[need.reasons.length - 1] ?? "tent"}</span>}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10.5px] uppercase tracking-[0.1em] text-meta">First stop</div>
                      <div className="text-[15px] font-medium tabular-nums">{first ? formatClockTime(first) : "—"}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
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
  void icon;
  return (
    <section className="mb-6">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}</h2>
        <span className="text-[12px] text-meta">{when}</span>
      </div>
      {crew.length === 0 ? (
        <p className="text-[13px] text-meta">{emptyText}</p>
      ) : (
        <div className="border border-border">
          {crew.map((c) => (
            <div key={c.userId} className="flex items-center justify-between border-t border-[var(--row-rule)] px-3 py-2 text-[13.5px] first:border-t-0">
              <span className="font-medium">{c.name}</span>
              {c.title && <span className="text-[12px] uppercase tracking-[0.06em] text-meta">{c.title}</span>}
            </div>
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
      <Link href={href(prev)} aria-label="Previous day" className="flex size-9 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
        <ChevronLeft className="size-4" />
      </Link>
      <DatePicker date={date} today={today} basePath="/staffing" />
      <Link href={href(next)} aria-label="Next day" className="flex size-9 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
        <ChevronRight className="size-4" />
      </Link>
    </div>
  );
}
