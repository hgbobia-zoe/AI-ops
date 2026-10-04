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
import {
  RouteStaffBoard,
  type RouteCardData,
  type RouteRecs,
  type MatchedGig,
} from "@/components/scheduling/RouteStaffBoard";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate } from "@/lib/db/repo";
import { getShiftsForDate } from "@/lib/scheduling/store";
import { computeCoverage } from "@/lib/scheduling/coverage";
import { recommendCrew, type CrewRecommendation } from "@/lib/scheduling/availability";
import { shiftWindowHours, gigWindowHours, internalRateFor, internalSeat, tempSeat, computeTempExposure, type LaborSeat } from "@/lib/scheduling/cost";
import { optimizeStaffing } from "@/lib/scheduling/optimize";
import { StaffingPlanPreview } from "@/components/scheduling/StaffingPlanPreview";
import { computeShiftReadiness } from "@/lib/scheduling/readiness";
import { scanShiftExceptions } from "@/lib/scheduling/exceptions";
import { getAssignmentsForDate } from "@/lib/scheduling/assignments";
import { isLiveAssignment } from "@/lib/scheduling/lifecycle";
import { shiftCommsEnabled } from "@/lib/scheduling/commsFlag";
import { ShiftReadinessExceptions, type ReadinessRow } from "@/components/scheduling/ShiftReadinessExceptions";
import { ROLE_LABEL } from "@/components/scheduling/RouteStaffBoard";
import {
  getCrewForDateSafe,
  getUsersList,
  getPayRates,
  connecteamConfigured,
  shiftClock,
  type CrewMember,
  type CrewShift,
  type PayRate,
} from "@/lib/connecteam";
import { getInstaworkShifts, instaworkConfigured } from "@/lib/instawork/client";
import { summarizeInstaworkByRole, instaworkShiftsForDate, instaworkGigsForRoute } from "@/lib/instawork/reconcile";
import { todayInOpsTz, shiftYmd, formatYmdLong } from "@/lib/dates";
import { shiftGap, type ShiftRole, type StaffShift } from "@/lib/scheduling/types";
import { routeWindow } from "@/lib/risk/engine";
import { DEFAULT_RISK_CONFIG, type EngineRoute } from "@/lib/risk/types";
import type { Route } from "@/lib/types";
import { BladeAgents } from "@/components/aiorg/BladeAgents";

const ROLE_ORDER: ShiftRole[] = ["driver", "field", "prep"];

// Clock read lives outside render (the react-hooks/purity rule forbids Date.now() in a component body).
function nowMs(): number {
  return Date.now();
}

/** A route's operational window, taken from its shifts' own known windows (never fabricated). */
function windowFromShifts(rs: StaffShift[]): { start: string | null; end: string | null; known: boolean } {
  const withWin = rs.filter((s) => s.windowKnown && s.startTime);
  if (withWin.length === 0) return { start: null, end: null, known: false };
  let start = withWin[0].startTime!;
  let end: string | null = null;
  for (const s of withWin) {
    if (s.startTime! < start) start = s.startTime!;
    if (s.endTime && (end === null || s.endTime > end)) end = s.endTime;
  }
  return { start, end, known: true };
}

/** The route's OWN operating window, straight from its stop times (same routeWindow the driver shift uses:
 *  first stop − load buffer … last stop + return buffer). Routes always carry stop times, so this is the
 *  authoritative window even before any shift is built — returned as ISO to match windowFromShifts. */
function routeOwnWindow(route: Route): { start: string | null; end: string | null; known: boolean } {
  const er: EngineRoute = {
    routeId: route.routeId,
    truckId: route.truckId,
    date: route.date,
    status: route.status,
    gsRouteId: route.gsRouteId,
    driverId: route.driverId,
    driverName: route.driverName,
    stops: route.stops.map((s) => ({ sequence: s.sequence, custName: s.custName, kind: s.kind, plannedWindow: s.plannedWindow, eta: s.eta, items: s.items })),
  };
  const w = routeWindow(er, DEFAULT_RISK_CONFIG);
  if (!w) return { start: null, end: null, known: false };
  return { start: new Date(w.startUnix * 1000).toISOString(), end: new Date(w.endUnix * 1000).toISOString(), known: true };
}

/** The window to show/assign for a route: a hand-tuned shift window wins when present, else the route's own
 *  stop-derived window — so a route with times never reads "Set time" just because no shift exists yet. */
function windowFor(route: Route, rs: StaffShift[]): { start: string | null; end: string | null; known: boolean } {
  const w = windowFromShifts(rs);
  return w.known ? w : routeOwnWindow(route);
}

/** A synthetic StaffShift for recommendCrew when a route+role has no shift yet (so "Add worker" can still
 *  show who's free). Only the fields recommendCrew reads matter; the rest are honest defaults. */
function syntheticShift(date: string, role: ShiftRole, win: { start: string | null; end: string | null; known: boolean }, assignees: number[]): StaffShift {
  return {
    id: "", date, role, headcount: 1,
    startTime: win.start, endTime: win.end, windowKnown: win.known,
    location: null, routeId: null, truckId: null, eventLabel: null, reasons: [], notes: null,
    source: "derived", status: "draft", assignees, instaworkHeadcount: 0, payRate: null,
    connecteamShiftId: null, connecteamSchedulerId: null, connecteamPublishedAt: null,
    instaworkGigId: null, instaworkPostedAt: null,
    lifecycleState: null, supervisorUserId: null, reportLocation: null, reportTime: null, equipment: [], instructions: null,
    createdAt: "", updatedAt: "",
  } satisfies StaffShift;
}

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
    .flatMap((t) => getRoutesForDate(t.truckId, date))
    .filter((r) => r.status !== "done");

  const shifts = getShiftsForDate(date);
  // Per-worker assignment rows (the lifecycle keystone), kept in lock-step with assignees by the live
  // assign path. Readiness + exceptions compute over these real rows instead of a hardcoded 0.
  const assignmentsByShift = getAssignmentsForDate(date);
  const commsWired = shiftCommsEnabled();

  const configured = connecteamConfigured();
  const [coverage, roster, rates] = configured
    ? await Promise.all([getCrewForDateSafe(date), getUsersList(), getPayRates(date, date)])
    : [{ ok: false, shifts: [] as CrewShift[] }, [] as CrewMember[], new Map<number, PayRate[]>()];

  // Distinct crew already on the Connecteam schedule this day (dedup by userId).
  const scheduledCrew = dedupCrew(coverage.shifts.flatMap((s) => s.assignees));
  const busyUserIds = [...new Set(scheduledCrew.map((a) => a.userId))];
  const driverScheduled = scheduledCrew.filter((a) => a.role === "driver");
  const prepScheduled = scheduledCrew.filter((a) => a.role === "prep");

  // Warehouse/prep crew scheduled in Connecteam THIS day, with their shift windows. Prep isn't tied to a
  // route (it's day-level work — on the ground the delivery day), so without this the "N prep scheduled"
  // count has nowhere to show — this surfaces the actual people + times in a day-level section on the board.
  // userIds already pulled onto a route (any route-tied app shift) — a warehouse person MOVED to a route as
  // a helper shouldn't still read as warehouse crew, so they drop out of this list (leaving a prep gap the
  // section shows honestly).
  const routeAssignedIds = new Set<number>(shifts.filter((s) => s.routeId).flatMap((s) => s.assignees));
  const prepCrewToday: { userId: number; name: string; title: string | null; window: string }[] = [];
  if (coverage.ok) {
    const seen = new Set<string>();
    for (const cs of coverage.shifts) {
      for (const a of cs.assignees) {
        if (a.role !== "prep" || seen.has(a.name) || routeAssignedIds.has(a.userId)) continue;
        seen.add(a.name);
        prepCrewToday.push({ userId: a.userId, name: a.name, title: a.title ?? null, window: `${shiftClock(cs.startUnix, cs.timezone)} – ${shiftClock(cs.endUnix, cs.timezone)}` });
      }
    }
  }

  // Net the scheduled crew against demand so a shift someone's already on doesn't read as a gap.
  const cov = computeCoverage(shifts, scheduledCrew);

  // Per-shift recommendations: who's actually FREE for this window + role (excludes office/admin). The
  // human picks from these (or posts to Instawork) — grounded in the Connecteam schedule, not a guess.
  const recommendations: Record<string, CrewRecommendation[]> = {};
  if (configured && coverage.ok) {
    for (const s of shifts) recommendations[s.id] = recommendCrew(s, coverage.shifts, roster);
  }

  // Instawork (temp labor): what's already booked/pending for this day, to reconcile against the gap.
  const iwOn = instaworkConfigured();
  const iw = iwOn ? await getInstaworkShifts() : null;
  const iwDayShifts = iw?.ok ? instaworkShiftsForDate(iw.shifts, date) : [];
  const iwByRole = iw?.ok ? summarizeInstaworkByRole(iw.shifts, date) : null;

  // ── Route-centric board data ──────────────────────────────────────────────
  // Group the day's shifts by route. Each active route becomes a card; shifts not tied to a route (the
  // day-before prep shift, manual shifts) fall into "other". Instawork gigs are matched to each route by
  // day + role + time-overlap (a gig can match several routes — it isn't truck-specific).
  const truckName = (id: string): string => trucks.find((t) => t.truckId === id)?.name ?? id;
  const routeIds = new Set(routes.map((r) => r.routeId));

  const routeCards: RouteCardData[] = routes.map((route) => {
    const rs = shifts.filter((s) => s.routeId === route.routeId);
    const win = windowFor(route, rs);
    const roles = (() => {
      const present = ROLE_ORDER.filter((role) => rs.some((s) => s.role === role));
      return present.length > 0 ? present : (["driver", "field"] as ShiftRole[]);
    })();
    const startMs = win.start ? Date.parse(win.start) : null;
    const endMs = win.end ? Date.parse(win.end) : null;
    const gigs: MatchedGig[] = instaworkGigsForRoute(iwDayShifts, { date, startMs, endMs, roles }).map((g) => ({
      id: g.id,
      position: g.position,
      workers: g.workers,
      filled: g.filled,
      total: g.total,
      pending: Math.max(0, g.total - g.filled),
    }));
    return {
      routeId: route.routeId,
      truckId: route.truckId,
      truckName: truckName(route.truckId),
      stopCount: route.stops.length,
      driverName: route.driverName ?? null,
      eventLabel: rs.find((s) => s.eventLabel)?.eventLabel ?? null,
      startTime: win.start,
      endTime: win.end,
      windowKnown: win.known,
      roles,
      gigs,
    };
  });

  // Per route+role availability for the Add-worker flow: who's FREE for the route window + role (excludes
  // office/admin via recommendCrew). Computed for every role so a role with no shift yet still shows crew.
  const routeRecs: RouteRecs = {};
  if (configured && coverage.ok) {
    for (const route of routes) {
      const rs = shifts.filter((s) => s.routeId === route.routeId);
      const win = windowFor(route, rs);
      const byRole: Partial<Record<ShiftRole, CrewRecommendation[]>> = {};
      for (const role of ROLE_ORDER) {
        const assignees = rs.filter((s) => s.role === role).flatMap((s) => s.assignees);
        byRole[role] = recommendCrew(syntheticShift(date, role, win, assignees), coverage.shifts, roster);
      }
      routeRecs[route.routeId] = byRole;
    }
  }

  // Prep is day-level warehouse staffing (no route) — its NEED + scheduled crew show in the "Warehouse /
  // Prep" section, so keep prep OUT of the generic "other" section (which is for manual / orphaned shifts).
  const prepNeed = shifts.filter((s) => s.role === "prep").reduce((n, s) => n + s.headcount, 0);
  const otherShifts = shifts.filter((s) => (!s.routeId || !routeIds.has(s.routeId)) && s.role !== "prep");

  // Per-route FIELD gap — lets the "move to a route" picker surface where a helper is actually wanted.
  const routeFieldNeed: Record<string, number> = {};
  for (const s of shifts) {
    if (!s.routeId || s.role !== "field") continue;
    routeFieldNeed[s.routeId] = (routeFieldNeed[s.routeId] ?? 0) + (cov.byShift[s.id]?.gap ?? shiftGap(s));
  }

  const peopleNeeded = shifts.reduce((n, s) => n + s.headcount, 0);

  // ── Day economics (read-only) — the deterministic temp-exposure metric. Internal seats are the covered
  // internal people per shift (explicit assignees + Connecteam-credited crew), costed at their pay rate;
  // temp seats are the day's BOOKED Instawork workers, costed at the gig base price. Hours come from the
  // window; an unknown rate/window stays null and is excluded from totals (never fabricated to 0).
  const laborSeats: LaborSeat[] = [];
  for (const s of shifts) {
    const hours = shiftWindowHours(s);
    const covShift = cov.byShift[s.id];
    const internalIds = [...s.assignees, ...(covShift?.scheduledUserIds ?? [])];
    for (const uid of internalIds) laborSeats.push(internalSeat(hours, internalRateFor(rates, uid, date)));
  }
  for (const gig of iwDayShifts) {
    const h = gigWindowHours(gig);
    for (let i = 0; i < gig.filled; i++) laborSeats.push(tempSeat(h, gig.basePrice));
  }
  const economics = computeTempExposure(laborSeats);

  // ── Optimizer PREVIEW (read-only) — the deterministic internal-first plan + the temp it would avoid.
  const staffingPlan = optimizeStaffing({
    date,
    shifts,
    coverage: cov,
    roster,
    dayShifts: coverage.shifts,
    rates,
    instawork: { ok: Boolean(iw?.ok), gigs: iw?.ok ? iw.shifts : [] },
  });
  const routeLabelFor = (routeId: string | null): string => {
    if (!routeId) return "Other";
    const r = routes.find((x) => x.routeId === routeId);
    return r ? truckName(r.truckId) : routeId;
  };

  // ── Readiness roll-up + exception queue (read-only, deterministic) ───────────────────────────────
  // STAFFING + LOGISTICS are computable now; the worker-facing loop (COMMUNICATION / TIMEKEEPING /
  // CONFIRMATION) is not wired yet (later phases), so those components are honestly UNVERIFIED rather
  // than fabricated red. Report time/location default to the shift start/location until explicitly set.
  const readinessRows: ReadinessRow[] = shifts.map((s) => {
    const gap = cov.byShift[s.id]?.gap ?? shiftGap(s);
    const live = (assignmentsByShift.get(s.id) ?? []).filter((a) => isLiveAssignment(a.state));
    const assignmentCount = live.length;
    // TIMEKEEPING is a LINK (not owned): an internal worker is linked once the shift is published to
    // Connecteam (its timesheet of record); a temp seat is linked once it is a booked gig. Honest red
    // ("Not linked to a timesheet") when not yet linked, so publishing visibly closes it.
    const timekeepingLinked =
      assignmentCount > 0 &&
      live.every((a) => (a.workerKind === "internal" ? Boolean(s.connecteamShiftId) : Boolean(a.instaworkGigId)));
    const r = computeShiftReadiness({
      gap,
      staffingUnverified: !coverage.ok,
      hasRoute: Boolean(s.routeId),
      truckSet: Boolean(s.truckId),
      windowKnown: s.windowKnown,
      reportTimeSet: Boolean(s.reportTime) || (s.windowKnown && Boolean(s.startTime)),
      reportLocationSet: Boolean(s.reportLocation || s.location),
      assignmentCount,
      allPacketsSent: assignmentCount > 0 && live.every((a) => a.packetSentAt != null),
      // COMMUNICATION + CONFIRMATION are only honestly assessable once the comms loop is live
      // (SHIFT_COMMS_ENABLED); until then they are UNVERIFIED, never a fabricated red.
      commsUnverified: !commsWired,
      timekeepingLinked,
      timekeepingUnverified: false,
      allConfirmed: assignmentCount > 0 && live.every((a) => a.confirmedAt != null),
      confirmationUnverified: !commsWired,
    });
    return { shiftId: s.id, routeId: s.routeId, roleLabel: ROLE_LABEL[s.role], level: r.level, score: r.score, blockers: r.blockers };
  });
  const shiftExceptions = scanShiftExceptions({ shifts, coverage: cov, now: nowMs(), staffingVerified: coverage.ok, assignmentsByShift, commsWired });
  const money = (n: number | null): string => (n == null ? "n/a" : `$${Math.round(n).toLocaleString()}`);
  const hrs = (n: number | null): string | number => (n == null ? "n/a" : n);
  const pct = (n: number | null): string => (n == null ? "n/a" : `${Math.round(n * 100)}%`);

  const figures: Figure[] = [
    { label: "Shifts", value: shifts.length },
    { label: "People needed", value: peopleNeeded },
    { label: "Internal", value: cov.internalTotal, tone: "positive" },
    { label: "Gap → Instawork", value: cov.gapTotal, tone: cov.gapTotal > 0 ? "attention" : "default", sep: true },
    { label: "Temp hrs", value: hrs(economics.tempHours), tone: economics.tempCount > 0 ? "attention" : "default", sep: true },
    { label: "Temp cost", value: money(economics.tempCost), tone: economics.tempCount > 0 ? "attention" : "default" },
    { label: "Premium vs internal", value: money(economics.incrementalTempCost) },
    { label: "Temp % hrs", value: pct(economics.tempHourShare) },
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

      <BladeAgents blade="scheduling" className="mb-5" />

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
        {!iwOn ? (
          <>
            {"Instawork isn't connected. Add the session cookie to reconcile booked temp labor. "}
            <Link href="/admin" className="underline underline-offset-2 hover:text-foreground">Fix in settings →</Link>
          </>
        ) : iw && !iw.ok ? (
          <>
            {"Instawork unverified: couldn't reach it, so this is not “nothing booked.” "}
            <Link href="/admin" className="underline underline-offset-2 hover:text-foreground">Fix in settings →</Link>
          </>
        ) : iwDayShifts.length === 0 ? (
          "Instawork today: nothing booked for this day."
        ) : (
          `Instawork today: ${iwDayShifts.reduce((n, s) => n + s.filled, 0)} booked, ${iwDayShifts.reduce((n, s) => n + Math.max(0, s.total - s.filled), 0)} pending across ${iwDayShifts.length} gig${iwDayShifts.length === 1 ? "" : "s"}.`
        )}
      </p>

      <ShiftReadinessExceptions rows={readinessRows} exceptions={shiftExceptions} routeLabel={routeLabelFor} />

      <StaffingPlanPreview plan={staffingPlan} date={date} routeLabel={routeLabelFor} />

      <RouteStaffBoard
        date={date}
        routeCards={routeCards}
        shifts={shifts}
        otherShifts={otherShifts}
        roster={roster}
        busyUserIds={busyUserIds}
        coverage={cov.byShift}
        recommendations={recommendations}
        routeRecs={routeRecs}
        prepCrewToday={prepCrewToday}
        prepNeed={prepNeed}
        routeFieldNeed={routeFieldNeed}
        instawork={iwByRole}
        iwConfigured={iwOn}
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
