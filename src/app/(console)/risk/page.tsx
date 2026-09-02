// Event Risk — matches how Zoe actually runs: items are prepped & LOADED THE DAY BEFORE
// (warehouse associates + event asset processors), and the DRIVER is scheduled on the
// event day. So for each day's routes we check two days: is prep/load crew on the
// schedule the day before, and is a driver on the schedule that day. Data: routes
// (Goodshuffle → our DB) + crew with roles (Connecteam "Title" field).

import Link from "next/link";
import {
  ShieldAlert,
  ShieldCheck,
  UserRound,
  Truck,
  PackageCheck,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
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
import { todayInOpsTz, shiftYmd, formatYmdLong, formatClockTime } from "@/lib/dates";
import type { Route } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function EventRiskPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const sp = await searchParams;
  const today = todayInOpsTz();
  const date = sp?.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const dayBefore = shiftYmd(date, -1);
  const isToday = date === today;

  const trucks = getActiveVehicles();
  const routes = trucks
    .map((t) => getRouteForDate(t.truckId, date))
    .filter((r): r is Route => Boolean(r) && r!.status !== "done");

  const configured = connecteamConfigured();
  const [crewD, crewPrev] = configured
    ? await Promise.all([getCrewForDate(date), getCrewForDate(dayBefore)])
    : [[], []];

  const driversD = distinctByRole(crewD, "driver");
  const prepPrev = distinctByRole(crewPrev, "prep");
  const prepD = distinctByRole(crewD, "prep");
  const openShifts = [...crewD, ...crewPrev].filter((s) => s.isOpen).length;

  const flags = computeFlags({ routes, date, dayBefore, driversD, prepPrev, prepD, openShifts, configured });

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      {isToday && <AutoRefresh seconds={60} />}

      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <ShieldAlert className="size-7" /> Event Risk
          </h1>
          <p className="text-sm text-muted-foreground">
            {routes.length} route{routes.length === 1 ? "" : "s"} · {driversD.length} driver
            {driversD.length === 1 ? "" : "s"} · {prepPrev.length} prep crew (day before)
          </p>
        </div>
        <DateNav date={date} today={today} />
      </header>

      {/* Risk flags */}
      <section className="mb-8">
        {flags.length === 0 ? (
          <div className="flex items-center gap-2 border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            <ShieldCheck className="size-5 shrink-0" />
            {configured
              ? "Prep the day before and a driver on the day — no staffing risks flagged."
              : "Connect Connecteam to check staffing coverage."}
          </div>
        ) : (
          <div className="space-y-2">
            {flags.map((f, i) => (
              <div
                key={i}
                className={`flex items-start gap-2.5 border p-4 text-sm ${
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

      {/* Prep & load — the day before */}
      <RoleSection
        icon={<PackageCheck className="size-4" />}
        title="Prep & load"
        when={`Day before · ${formatYmdLong(dayBefore)}`}
        crew={prepPrev}
        emptyText={
          configured ? "No warehouse / asset crew scheduled the day before." : "Connecteam not connected."
        }
      />

      {/* Drivers — event day */}
      <RoleSection
        icon={<Truck className="size-4" />}
        title="Drivers"
        when={`Event day · ${isToday ? "Today" : formatYmdLong(date)}`}
        crew={driversD}
        emptyText={configured ? "No driver scheduled." : "Connecteam not connected."}
      />

      {/* Routes */}
      <section className="mb-2 space-y-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Truck className="size-4" /> Routes
        </h2>
        {routes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active routes for {isToday ? "today" : formatYmdLong(date)}.</p>
        ) : (
          routes.map((r) => {
            const first = earliestStopOfRoute(r);
            return (
              <div key={r.routeId} className="surface flex items-center justify-between gap-3 border border-white/5 p-3">
                <div className="flex items-center gap-2.5">
                  <span className="btn-hero flex size-8 items-center justify-center">
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
    </main>
  );
}

interface Flag {
  severity: "high" | "warn";
  text: string;
}

function computeFlags(a: {
  routes: Route[];
  date: string;
  dayBefore: string;
  driversD: CrewMember[];
  prepPrev: CrewMember[];
  prepD: CrewMember[];
  openShifts: number;
  configured: boolean;
}): Flag[] {
  const flags: Flag[] = [];
  if (!a.configured || a.routes.length === 0) return flags;

  // Driver on the event day.
  if (a.driversD.length === 0) {
    flags.push({ severity: "high", text: `No driver scheduled for ${formatYmdLong(a.date)} — the route can't roll.` });
  } else if (a.driversD.length < a.routes.length) {
    flags.push({
      severity: "warn",
      text: `Only ${a.driversD.length} driver${a.driversD.length === 1 ? "" : "s"} scheduled for ${a.routes.length} routes.`,
    });
  }

  // Prep & load the day before.
  if (a.prepPrev.length === 0) {
    if (a.prepD.length > 0) {
      flags.push({
        severity: "warn",
        text: `Prep/load crew is only scheduled same-day, not the day before (${formatYmdLong(a.dayBefore)}) — items may not be loaded before departure.`,
      });
    } else {
      flags.push({
        severity: "high",
        text: `No warehouse / asset crew scheduled the day before (${formatYmdLong(a.dayBefore)}) to prep & load.`,
      });
    }
  }

  if (a.openShifts > 0) {
    flags.push({ severity: "warn", text: `${a.openShifts} open shift${a.openShifts === 1 ? "" : "s"} unassigned.` });
  }
  return flags;
}

function distinctByRole(shifts: CrewShift[], role: CrewRole): CrewMember[] {
  const m = new Map<number, CrewMember>();
  for (const s of shifts) for (const a of s.assignees) if (a.role === role) m.set(a.userId, a);
  return [...m.values()];
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
}) {
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
            <span
              key={c.userId}
              className="inline-flex items-center gap-1.5 border border-white/10 bg-white/5 px-2.5 py-1 text-sm"
            >
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

function DateNav({ date, today }: { date: string; today: string }) {
  const prev = shiftYmd(date, -1);
  const next = shiftYmd(date, 1);
  const isToday = date === today;
  const href = (d: string) => (d === today ? "/risk" : `/risk?date=${d}`);
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
