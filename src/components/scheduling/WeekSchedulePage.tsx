// /scheduling?view=week: the Week schedule (server rendered). Owner request 2026-11-13: "a weekly view same
// as Connecteam on top of the daily view". Loads the seven days (Monday to Sunday) the same way the Day
// schedule loads one: Dispatch shifts, the Connecteam schedule (weekly chunks, cached), and unavailability
// (cached per person per week), then builds the grid with weekGrid.ts. Read only; edits happen in the day.

import Link from "next/link";
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Truck } from "lucide-react";
import { WeekSchedule } from "@/components/scheduling/WeekSchedule";
import { buildWeekGrid, weekDayLabel, weekStartOf, type WeekDayInput } from "@/lib/scheduling/weekGrid";
import { getShiftsForDateRange } from "@/lib/scheduling/store";
import { dedupeRosterByName } from "@/lib/scheduling/roster";
import { assignmentWindowsFromShifts, getDayAvailabilityCached } from "@/lib/scheduling/eligibilityInputs";
import { buildRouteOptions } from "@/lib/scheduling/routeOptions";
import type { WeekEditDay } from "@/components/scheduling/WeekSchedule";
import type { Route } from "@/lib/types";
import { connecteamConfigured, getCrewForDateSafe, getUsersList, type CrewMember, type CrewShift } from "@/lib/connecteam";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate } from "@/lib/db/repo";
import { DISPLAY_TZ, opsLocalInputToIso, opsYmdOfMs, shiftYmd } from "@/lib/dates";

const TAB = "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] transition-colors";
const NAV = "flex size-9 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-[var(--row-hover)] hover:text-foreground";

export async function WeekSchedulePage({ date, today }: { date: string; today: string }): Promise<React.JSX.Element> {
  const start = weekStartOf(date);
  const days = Array.from({ length: 7 }, (_, i) => shiftYmd(start, i));
  const end = days[6];

  const shifts = getShiftsForDateRange(start, end).filter((s) => s.status !== "cancelled");
  const trucks = getActiveVehicles();
  const truckOfRoute = new Map<string, string>();
  const routesByDay = new Map<string, Route[]>();
  for (const d of days) {
    const list: Route[] = [];
    for (const t of trucks) for (const r of getRoutesForDate(t.truckId, d)) {
      truckOfRoute.set(r.routeId, t.name || t.truckId);
      if (r.status !== "done") list.push(r);
    }
    routesByDay.set(d, list);
  }
  const truckName = (id: string): string => trucks.find((t) => t.truckId === id)?.name ?? id;

  const configured = connecteamConfigured();
  const crews: Array<{ ok: boolean; shifts: CrewShift[] }> = configured ? await Promise.all(days.map((d) => getCrewForDateSafe(d))) : days.map(() => ({ ok: false, shifts: [] }));
  const rosterAll: CrewMember[] = configured ? await getUsersList() : [];
  const roster = dedupeRosterByName(rosterAll, [...shifts.flatMap((s) => s.assignees), ...crews.flatMap((c) => c.shifts.flatMap((cs) => cs.assignees.map((a) => a.userId)))]);
  const ids = roster.map((m) => m.userId);
  const avail = configured ? await Promise.all(days.map((d) => getDayAvailabilityCached(d, ids))) : days.map(() => ({ ok: false, byUser: new Map() }));

  const inputs: WeekDayInput[] = days.map((d, i) => ({
    date: d,
    dayStartMs: Date.parse(opsLocalInputToIso(`${d}T00:00`) ?? `${d}T00:00:00Z`),
    appShifts: shifts.filter((s) => s.date === d),
    gapByShift: {},
    // A Connecteam shift belongs to the day it starts (an overnight shift isn't shown twice).
    connecteamShifts: crews[i].shifts.filter((cs) => opsYmdOfMs(cs.startUnix * 1000) === d),
    unavailability: [...avail[i].byUser.values()].flat(),
  }));
  // Inline editing: what the shift editor needs for each day (the same inputs the Day schedule gives it).
  const editDays: Record<string, WeekEditDay> = Object.fromEntries(
    days.map((d, i) => [
      d,
      {
        routeOptions: buildRouteOptions(routesByDay.get(d) ?? [], truckName),
        eligibilityData: {
          dayShifts: crews[i].shifts,
          assignments: assignmentWindowsFromShifts(inputs[i].appShifts),
          unavailability: inputs[i].unavailability,
          availabilityKnown: avail[i].ok,
        },
      },
    ]),
  );
  const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TZ, hour: "numeric", minute: "2-digit" });
  const grid = buildWeekGrid({
    days: inputs,
    roster,
    routeLabel: (id) => (id ? truckOfRoute.get(id) ?? null : null),
    clock: (ms) => clockFmt.format(ms).replace(/\s?([AP])M$/, (_m, ap: string) => ap.toLowerCase()),
    today,
  });

  const thisWeek = weekStartOf(today);
  const weekHref = (ymd: string): string => (ymd === thisWeek ? "/scheduling?view=week" : `/scheduling?view=week&date=${ymd}`);
  const dayDate = days.includes(date) ? date : start;
  const range = `${weekDayLabel(start).split(" ")[1]} to ${weekDayLabel(end).split(" ")[1]}`;
  const unverified = configured && (crews.some((c) => !c.ok) || avail.some((a) => !a.ok));

  return (
    <main className="p-6">
      <header className="mb-4">
        <h1 className="text-[22px] font-medium tracking-tight">Scheduling</h1>
        <p className="text-[12.5px] text-meta">Week of {weekDayLabel(start)}</p>
      </header>
      <section className="surface mb-6 rounded-lg border border-border" aria-label="Week schedule">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="View" className="flex rounded-full border border-border p-0.5">
              <Link role="tab" aria-selected={false} href={`/scheduling?date=${dayDate}`} className={`${TAB} text-tertiary-text hover:text-foreground`}>
                <CalendarDays className="size-3.5" /> Day schedule
              </Link>
              <Link role="tab" aria-selected={false} href={`/scheduling?date=${dayDate}&view=routes`} className={`${TAB} text-tertiary-text hover:text-foreground`}>
                <Truck className="size-3.5" /> By route
              </Link>
              <span role="tab" aria-selected className={`${TAB} bg-foreground text-background`}>
                <CalendarRange className="size-3.5" /> Week
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Link href={weekHref(shiftYmd(start, -7))} aria-label="Previous week" className={NAV}>
                <ChevronLeft className="size-4" />
              </Link>
              <span className="rounded border border-border px-3 py-1.5 text-sm tabular-nums">{range}</span>
              <Link href={weekHref(shiftYmd(start, 7))} aria-label="Next week" className={NAV}>
                <ChevronRight className="size-4" />
              </Link>
              {start !== thisWeek && (
                <Link href="/scheduling?view=week" className="ml-1 rounded border border-border px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
                  This week
                </Link>
              )}
            </div>
          </div>
          <p className="text-[12.5px] text-meta">Click a shift to edit it, or an empty spot in a person&apos;s day to add one. Click a day to open it.</p>
        </div>
        {unverified && (
          <p className="border-b border-border px-4 py-2 text-[12.5px] text-status-warning">Connecteam did not answer for part of this week, so some Connecteam shifts or unavailability may be missing.</p>
        )}
        <WeekSchedule grid={grid} shifts={shifts} roster={roster} editDays={editDays} />
      </section>
    </main>
  );
}
