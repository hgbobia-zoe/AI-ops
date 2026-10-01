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
import { computeCoverage } from "@/lib/scheduling/coverage";
import {
  getCrewForDateSafe,
  getUsersList,
  connecteamConfigured,
  type CrewMember,
  type CrewShift,
} from "@/lib/connecteam";
import { getInstaworkShifts, instaworkConfigured } from "@/lib/instawork/client";
import { summarizeInstaworkByRole, instaworkShiftsForDate } from "@/lib/instawork/reconcile";
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

  // Distinct crew already on the Connecteam schedule this day (dedup by userId).
  const scheduledCrew = dedupCrew(coverage.shifts.flatMap((s) => s.assignees));
  const busyUserIds = [...new Set(scheduledCrew.map((a) => a.userId))];
  const driverScheduled = scheduledCrew.filter((a) => a.role === "driver");
  const prepScheduled = scheduledCrew.filter((a) => a.role === "prep");

  // Net the scheduled crew against demand so a shift someone's already on doesn't read as a gap.
  const cov = computeCoverage(shifts, scheduledCrew);

  // Instawork (temp labor): what's already booked/pending for this day, to reconcile against the gap.
  const iwOn = instaworkConfigured();
  const iw = iwOn ? await getInstaworkShifts() : null;
  const iwDayShifts = iw?.ok ? instaworkShiftsForDate(iw.shifts, date) : [];
  const iwByRole = iw?.ok ? summarizeInstaworkByRole(iw.shifts, date) : null;

  const peopleNeeded = shifts.reduce((n, s) => n + s.headcount, 0);

  const figures: Figure[] = [
    { label: "Shifts", value: shifts.length },
    { label: "People needed", value: peopleNeeded },
    { label: "Internal", value: cov.internalTotal, tone: "positive" },
    { label: "Gap → Instawork", value: cov.gapTotal, tone: cov.gapTotal > 0 ? "attention" : "default", sep: true },
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

      {/* Instawork context — temp labor already booked/pending for this day. */}
      <p className="mb-5 text-[12.5px] text-meta">
        {!iwOn
          ? "Instawork isn't connected — add the session cookie in Settings to reconcile booked temp labor."
          : iw && !iw.ok
            ? "Instawork unverified — couldn't reach it, so this is not “nothing booked.”"
            : iwDayShifts.length === 0
              ? "Instawork today: nothing booked for this day."
              : `Instawork today: ${iwDayShifts.reduce((n, s) => n + s.filled, 0)} booked, ${iwDayShifts.reduce((n, s) => n + Math.max(0, s.total - s.filled), 0)} pending across ${iwDayShifts.length} gig${iwDayShifts.length === 1 ? "" : "s"}.`}
      </p>

      <SchedulingBoard
        date={date}
        shifts={shifts}
        roster={roster}
        busyUserIds={busyUserIds}
        coverage={cov.byShift}
        instawork={iwByRole}
        hasRoutes={routes.length > 0}
      />
    </main>
  );
}

function dedupCrew(crew: CrewMember[]): CrewMember[] {
  const m = new Map<number, CrewMember>();
  for (const a of crew) m.set(a.userId, a);
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
