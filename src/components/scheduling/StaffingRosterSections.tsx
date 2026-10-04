// Staffing roster + open-shift context — the three unique pieces of the former /staffing blade, folded
// into /scheduling behind PROGRESSIVE DISCLOSURE (a native <details>, closed by default) so they add
// context without competing with the plan + route board above. Read-only Connecteam roster: who is
// scheduled by role (Prep day-before, Drivers event-day, Unload after-pickup, Office), plus the open-shift
// detector with free-crew suggestions. No app-owned shifts, no writes. The "Routes & crew needed" table
// from the old blade is intentionally dropped (the route cards already show crew needed per route).
//
// Comms style: no em-dashes, no emoji.

import { Truck, PackageCheck, PackageOpen, Briefcase, Users } from "lucide-react";
import { OpenShiftsPanel } from "@/components/OpenShiftsPanel";
import type { OpenShiftView } from "@/lib/staffing/openShifts";
import { type CrewShift, type CrewMember, type CrewRole } from "@/lib/connecteam";
import { formatYmdLong, formatClockTime } from "@/lib/dates";
import type { Route } from "@/lib/types";

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

export function StaffingRosterSections({
  configured,
  verified,
  openShifts,
  crewD,
  crewPrev,
  crewNext,
  routes,
  date,
  dayBefore,
  nextDay,
  isToday,
}: {
  configured: boolean;
  verified: boolean;
  openShifts: OpenShiftView[];
  crewD: CrewShift[];
  crewPrev: CrewShift[];
  crewNext: CrewShift[];
  routes: Route[];
  date: string;
  dayBefore: string;
  nextDay: string;
  isToday: boolean;
}): React.JSX.Element {
  const driversD = distinctByRole(crewD, "driver");
  const prepPrev = distinctByRole(crewPrev, "prep");
  const officeD = distinctByRole(crewD, "other");
  const hasPickups = routes.some((r) => r.stops.some((s) => s.kind === "pickup"));
  const routeEndUnix = latestStopUnix(routes);
  const unloadCrew = dedupById([...distinctPrepAfter(crewD, routeEndUnix), ...distinctByRole(crewNext, "prep")]);
  const openCount = verified ? openShifts.length : 0;

  return (
    <details className="group mt-6 border border-border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <span className="flex items-center gap-2">
          <Users className="size-4 text-meta" />
          <span className="text-[13px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Staffing roster and open shifts</span>
          {openCount > 0 && <span className="rounded border border-critical/50 px-1.5 py-px text-[10.5px] font-medium uppercase tracking-[0.06em] text-critical">{openCount} open</span>}
        </span>
        <span className="text-[11px] text-meta transition-colors group-hover:text-foreground">Connecteam roster (read only)</span>
      </summary>

      <div className="border-t border-border p-4">
        {!configured && <p className="mb-4 text-[12.5px] text-attention">Connecteam isn&apos;t connected — no crew data to show.</p>}

        {/* Open shifts (scheduled but unassigned) + suggested crew. */}
        <OpenShiftsPanel openShifts={openShifts} verified={verified} />

        <RoleSection
          icon={<PackageCheck className="size-4" />}
          title="Prep and load"
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
            title="Unload and clean"
            when={routeEndUnix ? `After pickup · trucks back ~${formatClockTime(new Date(routeEndUnix * 1000).toISOString())}` : "After pickup"}
            crew={unloadCrew}
            emptyText={configured ? `No one scheduled to unload — add a same-day evening or next-day (${formatYmdLong(nextDay)}) shift.` : "Connecteam not connected."}
          />
        )}

        {officeD.length > 0 && (
          <RoleSection icon={<Briefcase className="size-4" />} title="Also on the schedule" when="For awareness" crew={officeD} emptyText="" />
        )}
      </div>
    </details>
  );
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
    <section className="mb-6 last:mb-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}</h3>
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
