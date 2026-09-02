// Crew / staffing — today's Connecteam shifts, ready to line up against delivery routes
// (the staffing input for the AI Event Risk Engine). Read-only, auto-refreshing.

import Link from "next/link";
import { Users, Clock, MapPin, UserRound, ChevronLeft, ChevronRight, CalendarDays, Truck } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getCrewForDate, connecteamConfigured, shiftClock, type CrewShift } from "@/lib/connecteam";
import { todayInOpsTz, shiftYmd, formatYmdLong } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function StaffingPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const sp = await searchParams;
  const today = todayInOpsTz();
  const date = sp?.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const isToday = date === today;
  const configured = connecteamConfigured();
  const shifts = configured ? await getCrewForDate(date) : [];

  const totalPeople = new Set(shifts.flatMap((s) => s.assignees.map((a) => a.userId))).size;

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16">
      {isToday && <AutoRefresh seconds={60} />}

      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <Users className="size-7" /> Crew
          </h1>
          <p className="text-sm text-muted-foreground">
            {configured
              ? `${shifts.length} shift${shifts.length === 1 ? "" : "s"} · ${totalPeople} on the schedule`
              : "Connecteam not connected"}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <DateNav date={date} today={today} />
          <Link
            href="/dispatch"
            title="Dispatch"
            className="flex size-9 items-center justify-center rounded-lg border border-white/10 text-muted-foreground hover:text-foreground"
          >
            <Truck className="size-4" />
          </Link>
        </div>
      </header>

      {!configured && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          Set <span className="font-mono">CONNECTEAM_API_KEY</span> to pull the crew schedule.
        </div>
      )}

      {configured && shifts.length === 0 && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-muted-foreground">
          No crew scheduled for {isToday ? "today" : formatYmdLong(date)}.
        </div>
      )}

      <div className="space-y-3">
        {shifts.map((s) => (
          <ShiftCard key={s.id} shift={s} />
        ))}
      </div>
    </main>
  );
}

function ShiftCard({ shift }: { shift: CrewShift }) {
  return (
    <div className="surface space-y-3 rounded-2xl border border-white/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-semibold tabular-nums">
          <Clock className="size-4 text-muted-foreground" />
          {shiftClock(shift.startUnix, shift.timezone)} – {shiftClock(shift.endUnix, shift.timezone)}
        </div>
        {shift.isOpen ? (
          <span className="rounded-md bg-amber-400 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-black">
            Open shift
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{shift.assignees.length} assigned</span>
        )}
      </div>

      {shift.title && <div className="text-sm">{shift.title}</div>}

      <div className="flex flex-wrap gap-1.5">
        {shift.assignees.length === 0 ? (
          <span className="text-sm text-muted-foreground">Unassigned</span>
        ) : (
          shift.assignees.map((a) => (
            <span
              key={a.userId}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-sm"
            >
              <UserRound className="size-3.5 text-muted-foreground" />
              {a.name}
            </span>
          ))
        )}
      </div>

      {shift.address && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapPin className="size-3.5" /> {shift.address}
        </div>
      )}
    </div>
  );
}

function DateNav({ date, today }: { date: string; today: string }) {
  const prev = shiftYmd(date, -1);
  const next = shiftYmd(date, 1);
  const isToday = date === today;
  const href = (d: string) => (d === today ? "/staffing" : `/staffing?date=${d}`);
  return (
    <div className="flex items-center gap-1.5">
      <Link
        href={href(prev)}
        aria-label="Previous day"
        className="flex size-9 items-center justify-center rounded-lg border border-white/10 text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
      </Link>
      <span className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium">
        <CalendarDays className="size-4 text-muted-foreground" />
        {isToday ? "Today" : formatYmdLong(date)}
      </span>
      <Link
        href={href(next)}
        aria-label="Next day"
        className="flex size-9 items-center justify-center rounded-lg border border-white/10 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className="size-4" />
      </Link>
    </div>
  );
}
