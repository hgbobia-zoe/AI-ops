// Command Center — the single server-side aggregator behind the homepage. It composes the numbers
// the existing blade services already compute (ops attention, finance week, sales year, capacity,
// crew) into one payload, so the dashboard makes zero ad-hoc queries. Nothing here fabricates: a
// value that can't be resolved is null / UNVERIFIED and the UI says so.

import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import { getActiveVehicles } from "@/lib/vehicles";
import {
  getRouteForDate,
  getOpenExceptions,
  getPipelineBookingsInRange,
  getUpcomingCapacity,
  getPipelineBreakdown,
  type PipelineBreakdown,
} from "@/lib/db/repo";
import { opsOverview } from "@/lib/ops/service";
import { salesYearOverview, type SalesYearOverview } from "@/lib/sales/service";
import { getCrewForDateSafe } from "@/lib/connecteam";
import type { CrewRole } from "@/lib/connecteam";
import type { FinanceSummary } from "@/lib/finance/service";
import type { AttentionItem } from "@/lib/ops/manager";
import { sevenDayOutlook, dayStatus, type OutlookDay, type OpStatus } from "./calc";

export interface TodayOps {
  events: number; // booked events today
  scheduledRevenue: number | null; // committed $ scheduled today
  activeRoutes: number;
  trucksUsed: number;
  fleetSize: number;
  stops: number;
  deliveries: number;
  pickups: number;
  completed: number;
  inProgress: number;
  remaining: number;
  driversAssigned: number;
  exceptions: number;
}

export interface CrewAssignment {
  name: string;
  role: CrewRole;
  start: string; // "8:00 AM" local
  assignment: string; // shift title / job
}

export interface PeopleToday {
  verified: boolean; // Connecteam reachable
  peopleCount: number; // distinct assignees on the schedule today
  drivers: number;
  prep: number; // warehouse / asset processors
  other: number;
  openShifts: number; // unassigned shifts
  assignments: CrewAssignment[];
}

export interface CapacityDay {
  date: string;
  verdict: string;
  reasons: string[];
}

export interface CommandCenter {
  today: string;
  year: number;
  status: OpStatus;
  brief: string; // deterministic ops summary (the "AI summary" abstraction)
  attention: AttentionItem[];
  criticalOrHigh: number;
  today_ops: TodayOps;
  people: PeopleToday;
  finance: FinanceSummary | null; // this-week revenue/labor/contribution (money-gated in the UI)
  laborVerified: boolean;
  sales: SalesYearOverview; // year revenue + monthly trend
  pipeline: PipelineBreakdown; // real signed / quote / lost split (upcoming)
  capacity: CapacityDay[]; // upcoming non-AVAILABLE days (attention-worthy)
  outlook: OutlookDay[]; // next 7 days
}

const IN_PROGRESS = new Set(["EnRoute", "Arrived", "HeadingBack"]);
const DONE = new Set(["Completed", "Returned"]);

export async function commandCenter(): Promise<CommandCenter> {
  const today = todayInOpsTz();
  const year = Number(today.slice(0, 4));

  // Ops attention + this-week finance (one Connecteam call, inside opsOverview) — reused, not redone.
  const o = await opsOverview();
  const criticalOrHigh = o.items.filter((i) => i.priority === "critical" || i.priority === "high").length;

  // Today's execution, straight off the fleet's routes.
  const trucks = getActiveVehicles();
  const routes = trucks.map((t) => getRouteForDate(t.truckId, today)).filter((r): r is NonNullable<typeof r> => Boolean(r));
  const stops = routes.flatMap((r) => r.stops ?? []);
  const todayBookings = getPipelineBookingsInRange(today, today);
  const today_ops: TodayOps = {
    events: todayBookings.length,
    scheduledRevenue: sumSigned(todayBookings),
    activeRoutes: routes.filter((r) => r.status !== "done").length,
    trucksUsed: new Set(routes.map((r) => r.truckId)).size,
    fleetSize: trucks.length,
    stops: stops.length,
    deliveries: stops.filter((s) => s.kind !== "pickup").length,
    pickups: stops.filter((s) => s.kind === "pickup").length,
    completed: stops.filter((s) => DONE.has(s.state)).length,
    inProgress: stops.filter((s) => IN_PROGRESS.has(s.state)).length,
    remaining: stops.filter((s) => s.state === "Waiting").length,
    driversAssigned: routes.filter((r) => r.driverId).length,
    exceptions: getOpenExceptions().length,
  };

  // People on the schedule today (Connecteam). Honest UNVERIFIED when the API can't be reached.
  const crew = await getCrewForDateSafe(today);
  const seen = new Set<number>();
  const assignments: CrewAssignment[] = [];
  let drivers = 0;
  let prep = 0;
  let other = 0;
  let openShifts = 0;
  for (const s of crew.shifts) {
    if (s.isOpen && s.assignees.length === 0) openShifts++;
    for (const a of s.assignees) {
      assignments.push({ name: a.name, role: a.role, start: clockLabel(s.startUnix, s.timezone), assignment: s.title || s.address || "Scheduled" });
      if (!seen.has(a.userId)) {
        seen.add(a.userId);
        if (a.role === "driver") drivers++;
        else if (a.role === "prep") prep++;
        else other++;
      }
    }
  }
  assignments.sort((a, b) => a.start.localeCompare(b.start));
  const people: PeopleToday = { verified: crew.ok, peopleCount: seen.size, drivers, prep, other, openShifts, assignments };

  const sales = salesYearOverview(year);
  const pipeline = getPipelineBreakdown(today);

  // Forward capacity — only the days that actually warrant attention (not the AVAILABLE ones).
  const capAll = getUpcomingCapacity(today);
  const capacity: CapacityDay[] = capAll.filter((c) => c.verdict !== "AVAILABLE").slice(0, 6);
  const capacityByDate = new Map(capAll.map((c) => [c.date, c.verdict]));
  const anyConstrainedSoon = capAll.slice(0, 3).some((c) => c.verdict === "CONSTRAINED");

  // 7-day outlook.
  const weekBookings = getPipelineBookingsInRange(today, shiftYmd(today, 6)).map((b) => ({
    date: b.eventDate as string,
    revenue: b.grandTotal,
    signed: b.signed,
  }));
  const outlook = sevenDayOutlook(today, weekBookings, capacityByDate, 7);

  const status = dayStatus(today_ops.events, criticalOrHigh, anyConstrainedSoon);

  return {
    today,
    year,
    status,
    brief: o.brief,
    attention: o.items,
    criticalOrHigh,
    today_ops,
    people,
    finance: o.finance,
    laborVerified: o.laborVerified,
    sales,
    pipeline,
    capacity,
    outlook,
  };
}

function sumSigned(bookings: { grandTotal: number | null; signed: boolean }[]): number | null {
  let s: number | null = null;
  for (const b of bookings) if (b.signed && b.grandTotal != null) s = (s ?? 0) + b.grandTotal;
  return s;
}

function clockLabel(unix: number, tz: string): string {
  try {
    return new Date(unix * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  } catch {
    return "—";
  }
}
