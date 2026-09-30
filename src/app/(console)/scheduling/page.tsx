// Scheduling — the app-owned staffing schedule builder. The app is the source of truth: demand is
// derived from the day's routes (deterministic, same primitives as Event Risk), a human assigns internal
// crew, and the remaining gap becomes the Instawork top-up. This blade is the read/build UI over that
// model; the external pushes (Connecteam + Instawork) are wired in the next increment.
//
// FACTS ONLY: a shift with no known window shows "Set time" (never a fabricated time); when Connecteam
// is unreachable its coverage context reads "unverified" (never "nobody scheduled").

import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DatePicker } from "@/components/DatePicker";
import { AutoRefresh } from "@/components/AutoRefresh";
import { FigureStrip, type Figure } from "@/components/console-primitives";
import { SchedulingBoard } from "@/components/scheduling/SchedulingBoard";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRouteForDate } from "@/lib/db/repo";
import { getShiftsForDate } from "@/lib/scheduling/store";
import { shiftGap } from "@/lib/scheduling/types";
import {
  getCrewForDateSafe,
  getUsersList,
  connecteamConfigured,
  type CrewMember,
  type CrewShift,
} from "@/lib/connecteam";
import { todayInOpsTz, shiftYmd, formatYmdLong } from "@/lib/dates";
import type { Route } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SchedulingPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const today = todayInOpsTz();
  const date = sp?.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const isToday = date === today;

  const trucks = getActiveVehicles();
  const routes = trucks
    .map((t) => getRouteForDate(t.truckId, date))
    .filter((r): r is Route => Boolean(r) && r!.status !== "done");

  const shifts = getShiftsForDate(date);

  const configured = connecteamConfigured();
  const [coverage, roster] = configured
    ? await Promise.all([getCrewForDateSafe(date), getUsersList()])
    : [{ ok: false, shifts: [] as CrewShift[] }, [] as CrewMember[]];

  // Who already has a Connecteam shift this day → "busy" mark in the assignee picker.
  const busyUserIds = [...new Set(coverage.shifts.flatMap((s) => s.assignees.map((a) => a.userId)))];
  const driverScheduled = distinctByRole(coverage.shifts, "driver");
  const prepScheduled = distinctByRole(coverage.shifts, "prep");

  const peopleNeeded = shifts.reduce((n, s) => n + s.headcount, 0);
  const internalAssigned = shifts.reduce((n, s) => n + s.assignees.length, 0);
  const gapTotal = shifts.reduce((n, s) => n + shiftGap(s), 0);

  const figures: Figure[] = [
    { label: "Shifts", value: shifts.length },
    { label: "People needed", value: peopleNeeded },
    { label: "Internal", value: internalAssigned, tone: "positive" },
    { label: "Gap → Instawork", value: gapTotal, tone: gapTotal > 0 ? "attention" : "default", sep: true },
  ];

  return (
    <main className="p-6">
      {isToday && <AutoRefresh seconds={90} />}
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Scheduling</h1>
          <p className="text-[12.5px] text-meta">
            {formatYmdLong(date)} · {routes.length} route{routes.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-end gap-6">
          <FigureStrip figures={figures} />
          <DateNav date={date} today={today} />
        </div>
      </header>

      {/* Connecteam coverage context — what's ALREADY scheduled internally that day. */}
      <p className="mb-5 text-[12.5px] text-meta">
        {!configured
          ? "Connecteam isn't connected — no internal coverage to compare against."
          : !coverage.ok
            ? "Connecteam coverage unverified — couldn't reach it, so this is not “nobody scheduled.”"
            : `Connecteam today: ${driverScheduled.length} driver${driverScheduled.length === 1 ? "" : "s"}, ${prepScheduled.length} prep already scheduled.`}
      </p>

      <SchedulingBoard
        date={date}
        shifts={shifts}
        roster={roster}
        busyUserIds={busyUserIds}
        hasRoutes={routes.length > 0}
      />
    </main>
  );
}

function distinctByRole(shifts: CrewShift[], role: CrewMember["role"]): CrewMember[] {
  const m = new Map<number, CrewMember>();
  for (const s of shifts) for (const a of s.assignees) if (a.role === role) m.set(a.userId, a);
  return [...m.values()];
}

function DateNav({ date, today }: { date: string; today: string }): React.JSX.Element {
  const prev = shiftYmd(date, -1);
  const next = shiftYmd(date, 1);
  const href = (d: string): string => (d === today ? "/scheduling" : `/scheduling?date=${d}`);
  return (
    <div className="flex items-center gap-1.5">
      <Link href={href(prev)} aria-label="Previous day" className="flex size-9 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
        <ChevronLeft className="size-4" />
      </Link>
      <DatePicker date={date} today={today} basePath="/scheduling" />
      <Link href={href(next)} aria-label="Next day" className="flex size-9 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
        <ChevronRight className="size-4" />
      </Link>
    </div>
  );
}
