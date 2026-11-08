// Whole team payroll vs revenue for a finance period. PURE + unit-tested (teamPayroll.test.ts).
//
// Why this exists: the per-project margins on /finance only carry the labor that the attribution cascade
// pins to routes and stops (drivers and truck crew). Warehouse and prep, sales and back office time is real
// payroll that never reaches a project, so a week could show a 91% average margin while payroll was larger
// than revenue. This module puts the WHOLE team's payroll next to the revenue it served.
//
// Payroll basis: the same per-worker estimate Payroll Review shows (src/lib/payroll/review.ts, classifyWorker:
// Connecteam timesheet hours dated inside the range x the Gusto/override/Connecteam rate, USD only, no
// overtime premium). Nothing is pro-rated: only hours actually clocked on days inside the range count. For a
// Mon to Sun range the total equals Payroll Review's "Est. gross" for that week.
//
// Revenue basis ("revenue served"): Zoe's events drop off Thursday to Saturday and are picked up Monday to
// Wednesday of the following week, so a Mon to Sun payroll week serves the pickups of the PRIOR week's events
// plus the prep and delivery of THIS week's events. Each signed event's revenue is therefore split evenly:
// half to the range holding its event date (delivery) and half to the range 7 days later (pickup). For a
// range [start, end] that is 50% of signed revenue dated in [start, end] plus 50% of signed revenue dated in
// [start - 7, end - 7]. RULES CALCULATE: every figure is computed from the inputs, an unknown stays null.

import type { WorkerType } from "@/lib/payroll/types";
import type { ShiftRole } from "@/lib/scheduling/types";

/** Days between an event's delivery and its pickup (one week, see the header). */
export const PICKUP_LAG_DAYS = 7;
/** Share of an event's revenue credited to its delivery range; the rest goes to its pickup range. */
export const DELIVERY_SHARE = 0.5;

/** One plain sentence for the page that states the revenue basis. No dashes (house style). */
export const REVENUE_SERVED_NOTE =
  "Revenue served counts half of each signed event in the range it is delivered and half in the range a week later, when it is picked up.";
/** One plain sentence for the page that states the payroll basis. */
export const PAYROLL_BASIS_NOTE =
  "Payroll is the Payroll Review estimate: Connecteam hours clocked on days in this range times each worker's rate. Nothing is pro-rated.";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

function shift(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** The window whose events are being PICKED UP during [start, end] (the range shifted back one week). */
export function pickupWindow(start: string, end: string): { start: string; end: string } {
  return { start: shift(start, -PICKUP_LAG_DAYS), end: shift(end, -PICKUP_LAG_DAYS) };
}

/**
 * Revenue served in a range. `deliveryRevenue` = signed revenue with an event date in the range;
 * `pickupRevenue` = signed revenue with an event date in pickupWindow(range). A null side means no signed
 * event was found there and counts as 0 only when the other side is known; both null stays null.
 */
export function revenueServed(deliveryRevenue: number | null, pickupRevenue: number | null): number | null {
  if (deliveryRevenue == null && pickupRevenue == null) return null;
  return round2(DELIVERY_SHARE * (deliveryRevenue ?? 0) + (1 - DELIVERY_SHARE) * (pickupRevenue ?? 0));
}

// ── Team classification ──────────────────────────────────────────────────────────────────────────────

/** People module department (access_policy.id) to a payroll team. */
const DEPARTMENT_TEAM: Record<string, string> = {
  sales_associate: "Sales",
  sales: "Sales",
  warehouse: "Warehouse and prep",
  driver: "Drivers and crew",
  operations: "Back office",
  admin: "Back office",
  manager: "Back office",
};
/** Scheduling shift role (what they were rostered as in the range) to a payroll team. */
const SHIFT_ROLE_TEAM: Record<ShiftRole, string> = {
  driver: "Drivers and crew",
  field: "Drivers and crew",
  prep: "Warehouse and prep",
  office: "Back office",
};
export const UNASSIGNED_TEAM = "Unassigned";

export type TeamSource = "people" | "schedule" | "worker_type" | "none";

function isUS(country: string | null): boolean {
  if (!country) return true; // unknown country is not called international
  return /^(us|usa|united states( of america)?)$/i.test(country.trim());
}

/**
 * Resolve a worker's team, most explicit source first: the People record's department (HR's own
 * classification), then the shift role they were scheduled for most in the range, then an international
 * contractor flag. A non-US country is appended so offshore cost stays visible ("Sales (PH)"). Unknown
 * stays "Unassigned", never guessed.
 */
export function resolveTeam(inp: {
  department: string | null;
  shiftRoles: Map<ShiftRole, number> | null;
  workerType: WorkerType;
  country: string | null;
}): { team: string; source: TeamSource } {
  let base: string | null = null;
  let source: TeamSource = "none";
  if (inp.department && DEPARTMENT_TEAM[inp.department]) {
    base = DEPARTMENT_TEAM[inp.department];
    source = "people";
  } else if (inp.shiftRoles && inp.shiftRoles.size > 0) {
    // Most-rostered role; ties break in a fixed order so the result is deterministic.
    const order: ShiftRole[] = ["driver", "field", "prep", "office"];
    let best: ShiftRole | null = null;
    for (const r of order) {
      const n = inp.shiftRoles.get(r) ?? 0;
      if (n > 0 && (best == null || n > (inp.shiftRoles.get(best) ?? 0))) best = r;
    }
    if (best) {
      base = SHIFT_ROLE_TEAM[best];
      source = "schedule";
    }
  }
  const international = inp.workerType === "INTERNATIONAL_CONTRACTOR" || !isUS(inp.country);
  if (base == null && international) {
    base = "International";
    source = "worker_type";
  }
  if (base == null) return { team: UNASSIGNED_TEAM, source: "none" };
  const suffix = international && inp.country && !isUS(inp.country) ? ` (${inp.country.trim()})` : "";
  return { team: base + suffix, source };
}

// ── Summary ──────────────────────────────────────────────────────────────────────────────────────────

/** One paid worker in the range, as Payroll Review classified them, plus their resolved team. */
export interface TeamPayrollWorkerInput {
  key: string;
  name: string;
  hours: number | null;
  /** Payroll Review's estPay (hours x rate, USD); null when the rate or hours are unknown. */
  estPay: number | null;
  team: string;
  teamSource: TeamSource;
}

export interface TeamPayrollInput {
  /** False when Connecteam was unreachable: hours are unknown, so payroll is unavailable (never 0). */
  connecteamOk: boolean;
  workers: TeamPayrollWorkerInput[];
  /** Signed revenue with an event date in the range (delivery half). */
  deliveryRevenue: number | null;
  /** Signed revenue with an event date one week earlier (pickup half). */
  pickupRevenue: number | null;
  /** Labor the attribution cascade pinned to routes and stops in the range (the per-project basis). */
  attributedLabor: number | null;
  /** Instawork temp cost attributed in the range; temps are not on Payroll Review, so shown beside it. */
  tempLabor: number | null;
}

export interface TeamPayrollTeam {
  team: string;
  cost: number;
  hours: number;
  workers: number;
  /** Share of the known payroll total (0 to 1). */
  share: number | null;
}

export interface TeamPayrollWorker {
  key: string;
  name: string;
  team: string;
  teamSource: TeamSource;
  hours: number | null;
  cost: number | null;
}

export interface TeamPayrollSummary {
  available: boolean;
  payroll: number | null;
  hours: number | null;
  workerCount: number;
  /** Workers with hours but no estimate (missing or non-USD rate): the payroll total is a floor. */
  missingEstimate: string[];
  partial: boolean;
  teams: TeamPayrollTeam[];
  workers: TeamPayrollWorker[];
  unassignedCount: number;
  revenue: { delivery: number | null; pickup: number | null; served: number | null };
  /** payroll / revenue served (0 to n). Null when either side is unknown or revenue served is 0. */
  payrollPctOfServed: number | null;
  /** payroll / signed revenue dated in the range only (shown for reference, not the headline). */
  payrollPctOfDelivery: number | null;
  /** (revenue served - payroll) / revenue served: margin after the whole team's payroll. */
  marginAfterPayroll: number | null;
  attributedLabor: number | null;
  /** attributedLabor / payroll: how much of real payroll the per-project margins actually see. */
  attributedShareOfPayroll: number | null;
  tempLabor: number | null;
}

const ratio = (num: number | null, den: number | null): number | null =>
  num == null || den == null || den <= 0 ? null : round4(num / den);

/** Roll Payroll Review's per-worker estimates up by team and set them against revenue served. PURE. */
export function summarizeTeamPayroll(inp: TeamPayrollInput): TeamPayrollSummary {
  const delivery = inp.deliveryRevenue;
  const pickup = inp.pickupRevenue;
  const served = revenueServed(delivery, pickup);
  const workers = inp.connecteamOk ? inp.workers.filter((w) => (w.hours ?? 0) > 0) : [];

  const known = workers.filter((w) => w.estPay != null);
  const payroll = inp.connecteamOk && known.length > 0 ? round2(known.reduce((s, w) => s + (w.estPay ?? 0), 0)) : null;
  const hours = inp.connecteamOk ? round2(workers.reduce((s, w) => s + (w.hours ?? 0), 0)) : null;
  const missingEstimate = workers.filter((w) => w.estPay == null).map((w) => w.name);

  const byTeam = new Map<string, { cost: number; hours: number; workers: number }>();
  for (const w of workers) {
    const t = byTeam.get(w.team) ?? { cost: 0, hours: 0, workers: 0 };
    t.cost += w.estPay ?? 0;
    t.hours += w.hours ?? 0;
    t.workers += 1;
    byTeam.set(w.team, t);
  }
  const teams: TeamPayrollTeam[] = [...byTeam.entries()]
    .map(([team, t]) => ({ team, cost: round2(t.cost), hours: round2(t.hours), workers: t.workers, share: ratio(round2(t.cost), payroll) }))
    .sort((a, b) => b.cost - a.cost || a.team.localeCompare(b.team));

  const rows: TeamPayrollWorker[] = workers
    .map((w) => ({ key: w.key, name: w.name, team: w.team, teamSource: w.teamSource, hours: w.hours, cost: w.estPay }))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || a.name.localeCompare(b.name));

  return {
    available: payroll != null,
    payroll,
    hours,
    workerCount: workers.length,
    missingEstimate,
    partial: missingEstimate.length > 0,
    teams,
    workers: rows,
    unassignedCount: workers.filter((w) => w.team === UNASSIGNED_TEAM).length,
    revenue: { delivery, pickup, served },
    payrollPctOfServed: ratio(payroll, served),
    payrollPctOfDelivery: ratio(payroll, delivery),
    marginAfterPayroll: payroll != null && served != null && served > 0 ? round4((served - payroll) / served) : null,
    attributedLabor: inp.attributedLabor,
    attributedShareOfPayroll: ratio(inp.attributedLabor, payroll),
    tempLabor: inp.tempLabor,
  };
}
