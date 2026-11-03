// Command Center — the single server-side aggregator behind the homepage. It composes the numbers
// the existing blade services already compute (ops attention, finance week, sales year, capacity,
// crew) into one payload, so the dashboard makes zero ad-hoc queries. Nothing here fabricates: a
// value that can't be resolved is null / UNVERIFIED and the UI says so.

import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import { getActiveVehicles } from "@/lib/vehicles";
import {
  getRoutesForDate,
  getOpenExceptions,
  getPipelineBookingsInRange,
  getUpcomingCapacity,
  getPipelineBreakdown,
  getBookingsRevenueInRange,
  type PipelineBreakdown,
} from "@/lib/db/repo";
import { opsOverview } from "@/lib/ops/service";
import { salesYearOverview, type SalesYearOverview } from "@/lib/sales/service";
import { getCrewForDateSafe } from "@/lib/connecteam";
import type { CrewRole } from "@/lib/connecteam";
import { financeConfig } from "@/lib/finance/config";
import { getPeriod } from "@/lib/finance/periods";
import type { FinanceSummary } from "@/lib/finance/service";
import type { AttentionItem } from "@/lib/ops/manager";
import { getPullState } from "@/lib/pull/state";
import { listRecentSessions, listLiveSessions, type AiSession } from "@/lib/ai/sessions";
import { evaluateOutbox, liveOutboxSummary } from "@/lib/aiorg/outboxHealth";
import { countOpenExceptions } from "@/lib/payroll/store";
import { listGustoSubmitResults, readGustoConfirmWireResult } from "@/lib/payroll/gustoSubmitState";
import { listWireEvents } from "@/lib/payroll/wireEvent";
import { wireSeenFor, reminderDueAt, periodLabelOf } from "@/lib/payroll/wireReminder";
import { getActiveShiftExceptions } from "@/lib/scheduling/exceptionStore";
import { listNeedsReviewRange } from "@/lib/scheduling/store";
import { issueBreakdown } from "@/lib/postevent/metrics";
import { radarBoard } from "@/lib/radar/service";
import { buildBladeSignals, type BladeFacts, type HubItem } from "./bladeSignals";
import { sevenDayOutlook, dayStatus, computeRevenueOutlook, todaysExceptions, dataFreshness, aiActivityState, liveAiCount, type OutlookDay, type OpStatus, type RevenueOutlook, type DataFreshness } from "./calc";

/** This-MONTH path-to-target — the managerial "are we making our number?" number. Deterministic:
 *  signed vs a monthly target (derived from the weekly target) vs the open quotes that could close
 *  the gap. Coverage-based (not run-rate) because rental revenue is booked ahead. */
function monthRevenueOutlook(today: string): RevenueOutlook {
  const period = getPeriod("thisMonth", today);
  const rev = getBookingsRevenueInRange(period.start, period.end);
  const [y, m, d] = today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const weekly = financeConfig().weeklyRevenueTarget;
  const target = weekly != null ? Math.round((weekly * daysInMonth) / 7) : null;
  return computeRevenueOutlook({
    periodLabel: monthName,
    target,
    committed: rev.signed,
    pipeline: rev.pipeline,
    pctElapsed: (d / daysInMonth) * 100,
  });
}

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
  exceptions: number; // open exceptions on TODAY's stops (or stopless ones logged today), not all-time
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
  revenue: RevenueOutlook; // this-month path-to-target (money-gated in the UI)
  pipeline: PipelineBreakdown; // real signed / quote / lost split (upcoming)
  capacity: CapacityDay[]; // upcoming non-AVAILABLE days (attention-worthy)
  outlook: OutlookDay[]; // next 7 days
  gsData: DataFreshness; // age of the last Goodshuffle bookings pull (every booking/quote/revenue number)
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
  const routes = trucks.flatMap((t) => getRoutesForDate(t.truckId, today));
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
    exceptions: todaysExceptions(getOpenExceptions(), new Set(stops.map((s) => s.stopId)), today, (iso) => todayInOpsTz(new Date(iso))).length,
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
        else if (a.role === "prep" || a.role === "warehouse") prep++; // both warehouse roles roll into the warehouse count
        else other++;
      }
    }
  }
  assignments.sort((a, b) => a.start.localeCompare(b.start));
  const people: PeopleToday = { verified: crew.ok, peopleCount: seen.size, drivers, prep, other, openShifts, assignments };

  const sales = salesYearOverview(year);
  const revenue = monthRevenueOutlook(today);
  const pipeline = getPipelineBreakdown(today);

  // Forward capacity — only the days that actually warrant attention (not the AVAILABLE ones).
  const capAll = getUpcomingCapacity(today);
  const capacity: CapacityDay[] = capAll.filter((c) => c.verdict !== "AVAILABLE").slice(0, 6);
  const capacityByDate = new Map(capAll.map((c) => [c.date, c.verdict]));
  const crewByDate = new Map(capAll.map((c) => [c.date, { scheduled: c.scheduledDrivers, needed: c.driversNeeded }]));
  const anyConstrainedSoon = capAll.slice(0, 3).some((c) => c.verdict === "CONSTRAINED");

  // 7-day outlook.
  const weekBookings = getPipelineBookingsInRange(today, shiftYmd(today, 6)).map((b) => ({
    date: b.eventDate as string,
    revenue: b.grandTotal,
    signed: b.signed,
  }));
  const outlook = sevenDayOutlook(today, weekBookings, capacityByDate, 7, crewByDate);

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
    revenue,
    pipeline,
    capacity,
    outlook,
    gsData: dataFreshness(safeBookingsPullAt(), Date.now()),
  };
}

function safeBookingsPullAt(): string | null {
  try {
    return getPullState().sources?.["bookings"]?.at ?? null;
  } catch {
    return null;
  }
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

export interface AiSessionsView {
  sessions: (AiSession & { idle: boolean })[]; // most recent first; idle = marked running but silent
  live: number; // running with recent activity (AI_LIVE_FRESH_MIN)
}

/** The Command Center's AI panel: recent sessions, each tagged idle when it is marked running but has
 *  gone quiet, plus the live count by the same rule. Read-only over the AI control plane's tables. */
export function aiSessionsView(limit = 6): AiSessionsView {
  const now = Date.now();
  const recent = safeRead(() => listRecentSessions(limit), [] as AiSession[]);
  return {
    sessions: recent.map((s) => ({ ...s, idle: aiActivityState(s, now) === "idle" })),
    live: safeRead(() => liveAiCount(listLiveSessions(500), now), 0),
  };
}

function safeRead<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Live facts for the hub's blade signals. Every read is DB-only and isolated: a blade whose read
 *  throws contributes nothing rather than breaking the dashboard, and is reported to `onError`
 *  (logged by default) so a broken read is visible instead of silently empty. */
export function collectBladeSignals(
  today: string = todayInOpsTz(),
  onError: (blade: string, err: unknown) => void = (blade, err) => console.warn(`[command] ${blade} signal read failed:`, err),
): HubItem[] {
  const now = Date.now();
  const read = <T,>(blade: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      onError(blade, err);
      return fallback;
    }
  };
  const weekEnd = shiftYmd(today, 6);
  const facts: BladeFacts = {
    today,
    now,
    outbox: read("outbox", () => evaluateOutbox(liveOutboxSummary(now), now), null),
    payrollOpenExceptions: read("payroll-exceptions", () => countOpenExceptions(), null),
    wiresPending: read("payroll-wire", () => {
      const wires = listWireEvents(50);
      return listGustoSubmitResults(10)
        .filter((s) => s.ok && s.submitted && now - Date.parse(s.at) <= 48 * 3_600_000)
        .filter((s) => {
          const confirmed = readGustoConfirmWireResult(s.key);
          return !wireSeenFor(s, wires, !!(confirmed?.ok && confirmed.confirmed)) && now >= reminderDueAt(s.at, 1);
        })
        .map((s) => ({ label: periodLabelOf(s), submittedAt: s.at }));
    }, []),
    shiftExceptions: read("shift-exceptions", () => getActiveShiftExceptions(), []),
    needsReviewDates: read("needs-review", () => listNeedsReviewRange(today, weekEnd).map((s) => s.date), []),
    instawork: read("instawork", () => {
      const st = getPullState();
      return { ok: st.instaworkOk, failingSince: st.instaworkFailingSince ?? null };
    }, null),
    postEventOpenIssues: read("postevent", () => issueBreakdown().open, null),
    radarOutreach: read("radar", 
      () =>
        radarBoard(today)
          .rows.filter(
            (r) =>
              !r.event.isSeed &&
              r.qualification.tier === "HIGH" &&
              r.event.salesStatus === "NONE" &&
              (r.timing.phase === "OUTREACH_WINDOW" || r.timing.phase === "ACTIVELY_SHOPPING"),
          )
          .map((r) => ({ name: r.event.name, date: r.event.startDate })),
      [],
    ),
  };
  return buildBladeSignals(facts);
}
