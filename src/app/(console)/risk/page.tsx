// Event Risk — lines the day's crew (Connecteam) up against the delivery routes
// (Goodshuffle → our DB) and flags staffing risk: no crew for today's routes, crew
// starting too late to be ready before departure, open/unassigned shifts, and headcount.
// The crew-size rule (tent = 2, 40x60 = 3+) needs Goodshuffle line items we don't store
// yet — noted below as the next input to wire.

import Link from "next/link";
import {
  ShieldAlert,
  ShieldCheck,
  Clock,
  MapPin,
  UserRound,
  Truck,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
} from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getCrewForDate, connecteamConfigured, shiftClock, type CrewShift } from "@/lib/connecteam";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRouteForDate } from "@/lib/db/repo";
import { todayInOpsTz, shiftYmd, formatYmdLong, formatClockTime } from "@/lib/dates";
import type { Route } from "@/lib/types";

export const dynamic = "force-dynamic";

// How long before the first stop the crew should already be on the clock (arrive + load).
const READY_LEAD_MIN = 45;

export default async function EventRiskPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const sp = await searchParams;
  const today = todayInOpsTz();
  const date = sp?.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const isToday = date === today;

  const trucks = getActiveVehicles();
  const routes = trucks
    .map((t) => getRouteForDate(t.truckId, date))
    .filter((r): r is Route => Boolean(r) && r!.status !== "done");

  const crew = connecteamConfigured() ? await getCrewForDate(date) : [];
  const crewPeople = new Set(crew.flatMap((s) => s.assignees.map((a) => a.userId))).size;

  const flags = computeFlags(routes, crew);
  const earliestStop = earliestRouteTime(routes);
  const earliestCrew = crew.length ? Math.min(...crew.map((s) => s.startUnix)) : null;

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      {isToday && <AutoRefresh seconds={60} />}

      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <ShieldAlert className="size-7" /> Event Risk
          </h1>
          <p className="text-sm text-muted-foreground">
            {routes.length} route{routes.length === 1 ? "" : "s"} · {crewPeople} crew ·{" "}
            {crew.length} shift{crew.length === 1 ? "" : "s"}
          </p>
        </div>
        <DateNav date={date} today={today} />
      </header>

      {/* Risk flags */}
      <section className="mb-8">
        {flags.length === 0 ? (
          <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            <ShieldCheck className="size-5 shrink-0" />
            {connecteamConfigured()
              ? "No staffing risks flagged for this day."
              : "Connect Connecteam to check staffing coverage."}
          </div>
        ) : (
          <div className="space-y-2">
            {flags.map((f, i) => (
              <div
                key={i}
                className={`flex items-start gap-2.5 rounded-2xl border p-4 text-sm ${
                  f.severity === "high"
                    ? "border-red-500/30 bg-red-500/10 text-red-200"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                }`}
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{f.text}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Coverage timeline hint */}
      {earliestStop && (
        <p className="mb-6 text-xs text-muted-foreground">
          First stop today lands around <span className="font-medium text-foreground">{formatClockTime(earliestStop.iso)}</span>
          {earliestCrew != null && crew.length > 0 && (
            <>
              {" "}· earliest crew on the clock{" "}
              <span className="font-medium text-foreground">{shiftClock(earliestCrew, crew[0].timezone)}</span>
            </>
          )}
          . Crew should be loading ~{READY_LEAD_MIN} min before the first stop.
        </p>
      )}

      {/* Routes */}
      <section className="mb-8 space-y-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Truck className="size-4" /> Routes
        </h2>
        {routes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active routes for {isToday ? "today" : formatYmdLong(date)}.</p>
        ) : (
          routes.map((r) => {
            const first = earliestStopOfRoute(r);
            return (
              <div key={r.routeId} className="surface flex items-center justify-between gap-3 rounded-xl border border-white/5 p-3">
                <div className="flex items-center gap-2.5">
                  <span className="btn-hero flex size-8 items-center justify-center rounded-lg">
                    <Truck className="size-4" />
                  </span>
                  <div>
                    <div className="font-medium">{r.truckId}</div>
                    <div className="text-xs text-muted-foreground">{r.stops.length} stops</div>
                  </div>
                </div>
                <div className="text-right text-sm">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">First stop</div>
                  <div className="font-semibold tabular-nums">{first ? formatClockTime(first) : "—"}</div>
                </div>
              </div>
            );
          })
        )}
      </section>

      {/* Crew */}
      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <UserRound className="size-4" /> Crew
        </h2>
        {!connecteamConfigured() ? (
          <p className="text-sm text-muted-foreground">Connecteam not connected.</p>
        ) : crew.length === 0 ? (
          <p className="text-sm text-muted-foreground">No crew scheduled.</p>
        ) : (
          crew.map((s) => <ShiftRow key={s.id} shift={s} />)
        )}
      </section>

      <p className="mt-8 text-xs text-muted-foreground">
        Next input: crew-size rules (tent = 2 people, 40×60 = 3+) need Goodshuffle line items per event —
        we&apos;ve proven we can read those; wiring them in lets this flag under-crewed tent jobs.
      </p>
    </main>
  );
}

interface Flag {
  severity: "high" | "warn";
  text: string;
}

function computeFlags(routes: Route[], crew: CrewShift[]): Flag[] {
  const flags: Flag[] = [];
  if (routes.length === 0) return flags;

  const crewPeople = new Set(crew.flatMap((s) => s.assignees.map((a) => a.userId))).size;
  const openShifts = crew.filter((s) => s.isOpen).length;

  if (crew.length === 0) {
    flags.push({ severity: "high", text: `${routes.length} route${routes.length === 1 ? "" : "s"} scheduled but no crew on the schedule.` });
    return flags;
  }

  // Crew not on the clock early enough before the first stop.
  const earliest = earliestRouteTime(routes);
  const earliestCrew = Math.min(...crew.map((s) => s.startUnix));
  if (earliest) {
    const needBy = earliest.unix - READY_LEAD_MIN * 60;
    if (earliestCrew > needBy) {
      flags.push({
        severity: "high",
        text: `Earliest crew starts after the crew should already be loading (~${READY_LEAD_MIN} min before the first stop) — coverage may be late.`,
      });
    }
  }

  if (openShifts > 0) {
    flags.push({ severity: "warn", text: `${openShifts} open shift${openShifts === 1 ? "" : "s"} still unassigned.` });
  }

  if (crewPeople < routes.length) {
    flags.push({
      severity: "warn",
      text: `Only ${crewPeople} crew for ${routes.length} routes — likely too few for a driver + helper on each.`,
    });
  }

  return flags;
}

// Earliest parseable stop time across all routes (ISO), with its Unix seconds.
function earliestRouteTime(routes: Route[]): { iso: string; unix: number } | null {
  let best: { iso: string; unix: number } | null = null;
  for (const r of routes) {
    const iso = earliestStopOfRoute(r);
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    const unix = Math.floor(t / 1000);
    if (!best || unix < best.unix) best = { iso, unix };
  }
  return best;
}

// The earliest planned time (ISO) among a route's stops, or null if none parse.
function earliestStopOfRoute(r: Route): string | null {
  let best: string | null = null;
  let bestT = Infinity;
  for (const s of r.stops) {
    const raw = s.plannedWindow || s.eta;
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) continue;
    if (t < bestT) {
      bestT = t;
      best = raw;
    }
  }
  return best;
}

function ShiftRow({ shift }: { shift: CrewShift }) {
  return (
    <div className="surface flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/5 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold tabular-nums">
        <Clock className="size-4 text-muted-foreground" />
        {shiftClock(shift.startUnix, shift.timezone)} – {shiftClock(shift.endUnix, shift.timezone)}
      </div>
      <div className="flex flex-1 flex-wrap items-center justify-end gap-1.5">
        {shift.isOpen ? (
          <span className="rounded-md bg-amber-400 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-black">
            Open
          </span>
        ) : shift.assignees.length === 0 ? (
          <span className="text-sm text-muted-foreground">Unassigned</span>
        ) : (
          shift.assignees.map((a) => (
            <span key={a.userId} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-sm">
              <UserRound className="size-3.5 text-muted-foreground" />
              {a.name}
            </span>
          ))
        )}
      </div>
      {shift.address && (
        <div className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
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
  const href = (d: string) => (d === today ? "/risk" : `/risk?date=${d}`);
  return (
    <div className="flex items-center gap-1.5">
      <Link href={href(prev)} aria-label="Previous day" className="flex size-9 items-center justify-center rounded-lg border border-white/10 text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" />
      </Link>
      <span className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium">
        <CalendarDays className="size-4 text-muted-foreground" />
        {isToday ? "Today" : formatYmdLong(date)}
      </span>
      <Link href={href(next)} aria-label="Next day" className="flex size-9 items-center justify-center rounded-lg border border-white/10 text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-4" />
      </Link>
    </div>
  );
}
