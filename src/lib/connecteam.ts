// Connecteam — crew scheduling read (the staffing input for the AI Event Risk Engine).
// Connecteam has a real REST API (X-API-KEY header, no session/Cloudflare games), so this
// is a straight server-side integration. Key-gated: returns empty when CONNECTEAM_API_KEY
// is unset, never throws.
//
// API: https://api.connecteam.com  ·  header `X-API-KEY: <key>`
//   GET /users/v1/users?limit=                                  → the team
//   GET /scheduler/v1/schedulers                               → schedulers (we use the Job Scheduler)
//   GET /scheduler/v1/schedulers/{id}/shifts?startTime=&endTime= → shifts (Unix seconds)

const BASE = (process.env.CONNECTEAM_BASE_URL || "https://api.connecteam.com").replace(/\/$/, "");

export function connecteamConfigured(): boolean {
  return Boolean(process.env.CONNECTEAM_API_KEY);
}

async function ctGet(path: string, timeoutMs = 12000): Promise<unknown | null> {
  if (!connecteamConfigured()) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "X-API-KEY": process.env.CONNECTEAM_API_KEY!, accept: "application/json" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error("[connecteam] GET", path, "HTTP", res.status);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error("[connecteam] error", path, String(e));
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Ops role, derived from the Connecteam "Title" custom field. */
export type CrewRole = "driver" | "prep" | "other";

export interface CrewMember {
  userId: number;
  name: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  userType?: string;
  /** The Connecteam "Title" custom field, e.g. "Driver", "Warehouse Associate". */
  title?: string;
  role: CrewRole;
}

// Map a Title to an ops role. Drivers drive on the event day; warehouse associates +
// event asset processors prep/load (and process returns) — typically the day before.
export function roleFromTitle(title?: string): CrewRole {
  const t = (title || "").toLowerCase();
  if (t.includes("driver")) return "driver";
  if (t.includes("warehouse") || t.includes("asset")) return "prep";
  return "other";
}

/** Pull the "Title" custom field value off a raw Connecteam user. */
function titleOf(u: Record<string, unknown>): string | undefined {
  const fields = (u.customFields as Array<{ name?: string; value?: unknown }>) ?? [];
  const f = fields.find((x) => x.name === "Title");
  return typeof f?.value === "string" ? f.value : undefined;
}

export interface Scheduler {
  schedulerId: number;
  name: string;
  timezone: string;
}

export interface CrewShift {
  id: string;
  schedulerId: number;
  schedulerName: string;
  startUnix: number;
  endUnix: number;
  timezone: string;
  isOpen: boolean;
  title: string;
  jobId?: string;
  address?: string;
  /** Resolved assignee names (falls back to a user id when a name is missing). */
  assignees: CrewMember[];
}

type UsersResp = { data?: { users?: Array<Record<string, unknown>> } };
type SchedResp = { data?: { schedulers?: Array<Record<string, unknown>> } };
type ShiftsResp = { data?: { shifts?: Array<Record<string, unknown>> } };

/** The team, keyed by userId (name resolved from first/last). */
export async function getUsers(): Promise<Map<number, CrewMember>> {
  const j = (await ctGet("/users/v1/users?limit=300")) as UsersResp | null;
  const map = new Map<number, CrewMember>();
  for (const u of j?.data?.users ?? []) {
    const userId = Number(u.userId);
    if (!userId) continue;
    const firstName = (u.firstName as string) || "";
    const lastName = (u.lastName as string) || "";
    const title = titleOf(u);
    map.set(userId, {
      userId,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim() || `#${userId}`,
      phone: u.phoneNumber as string | undefined,
      email: u.email as string | undefined,
      userType: u.userType as string | undefined,
      title,
      role: roleFromTitle(title),
    });
  }
  return map;
}

export async function getSchedulers(): Promise<Scheduler[]> {
  const j = (await ctGet("/scheduler/v1/schedulers")) as SchedResp | null;
  return (j?.data?.schedulers ?? [])
    .filter((s) => !s.isArchived)
    .map((s) => ({
      schedulerId: Number(s.schedulerId),
      name: (s.name as string) || "Scheduler",
      timezone: (s.timezone as string) || "America/New_York",
    }));
}

async function getShifts(sched: Scheduler, startUnix: number, endUnix: number): Promise<Array<Record<string, unknown>>> {
  const j = (await ctGet(
    `/scheduler/v1/schedulers/${sched.schedulerId}/shifts?startTime=${startUnix}&endTime=${endUnix}&limit=500`,
  )) as ShiftsResp | null;
  return j?.data?.shifts ?? [];
}

/** `YYYY-MM-DD` for a Unix-seconds instant in timezone `tz`. */
function localYmd(unix: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unix * 1000));
}

export interface CrewDayResult {
  /** True only when we actually reached Connecteam (schedulers came back). When false the
   *  staffing data is UNVERIFIED — callers must NOT treat empty shifts as "nobody scheduled". */
  ok: boolean;
  shifts: CrewShift[];
}

/**
 * Crew shifts for a calendar day (YYYY-MM-DD) WITH a reachability flag. Fetches a padded
 * window (±1 day, to cover any timezone), then keeps shifts whose local start-day matches.
 * `ok` is false when Connecteam isn't configured or the API didn't respond — so an outage
 * can never be mistaken for an empty schedule (which would fabricate false staffing risks).
 */
export async function getCrewForDateSafe(date: string): Promise<CrewDayResult> {
  if (!connecteamConfigured()) return { ok: false, shifts: [] };
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return { ok: false, shifts: [] };
  const dayStartUtc = Date.UTC(y, m - 1, d) / 1000;
  const from = dayStartUtc - 86400; // pad ±1 day for tz spread
  const to = dayStartUtc + 2 * 86400;

  const [users, schedulers] = await Promise.all([getUsers(), getSchedulers()]);
  // A working Connecteam always returns at least one scheduler (+ users). Zero means the
  // fetch failed/was unreachable, not that the day is empty → report ok:false (unverified).
  const reachable = schedulers.length > 0 && users.size > 0;
  const out: CrewShift[] = [];
  for (const sched of schedulers) {
    const raw = await getShifts(sched, from, to);
    for (const s of raw) {
      const startUnix = Number(s.startTime);
      if (!startUnix) continue;
      if (localYmd(startUnix, sched.timezone) !== date) continue; // keep only this local day
      const ids = (s.assignedUserIds as number[]) ?? [];
      const loc = s.locationData as { gps?: { address?: string } } | undefined;
      out.push({
        id: String(s.id),
        schedulerId: sched.schedulerId,
        schedulerName: sched.name,
        startUnix,
        endUnix: Number(s.endTime) || startUnix,
        timezone: sched.timezone,
        isOpen: Boolean(s.isOpenShift),
        title: (s.title as string) || "",
        jobId: (s.jobId as string) || undefined,
        address: loc?.gps?.address || undefined,
        assignees: ids.map(
          (id): CrewMember => users.get(id) ?? { userId: id, name: `#${id}`, role: "other" },
        ),
      });
    }
  }
  out.sort((a, b) => a.startUnix - b.startUnix);
  return { ok: reachable, shifts: out };
}

/** Crew shifts for a day (shifts only; empty when unconfigured/unavailable). For display. */
export async function getCrewForDate(date: string): Promise<CrewShift[]> {
  return (await getCrewForDateSafe(date)).shifts;
}

// ── Financial: pay rates + timesheets (labor cost, MVP3) ─────────────────────
// Confirmed shapes (Connecteam API docs): pay rates GET /pay_rates/v1/pay_rates
// (data array of {userId, effectiveDate, rateType, <amount>}); time clocks GET
// /time_clock/v1/time_clocks → data.timeClock[{id,name}]; timesheet GET
// /time_clock/v1/time_clocks/{id}/timesheet?startDate&endDate → data.employees[]
// .dailyRecords[].dailyTotalHours. Never throws; empty on failure (caller treats as UNVERIFIED).

type Json = Record<string, unknown>;
function findArray(o: unknown, keys: string[]): Json[] {
  if (Array.isArray(o)) return o as Json[];
  if (o && typeof o === "object") {
    const obj = o as Json;
    for (const k of keys) if (Array.isArray(obj[k])) return obj[k] as Json[];
    if (obj.data && obj.data !== o) return findArray(obj.data, keys);
  }
  return [];
}
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface PayRate {
  userId: number;
  hourlyRate: number;
  effectiveDate: string; // YYYY-MM-DD
}

/** Hourly pay rates (with effective dates) for a date range. Empty when unconfigured/unavailable. */
export async function getPayRates(startDate: string, endDate: string): Promise<Map<number, PayRate[]>> {
  const map = new Map<number, PayRate[]>();
  if (!connecteamConfigured()) return map;
  // Confirmed shape (live probe): data.payRatesByUsers = [{ userId, payRate }], where payRate is
  // an object (or array w/ history) of { effectiveDate, rateType, defaultRate, resourcesRates, … }.
  const j = await ctGet(`/pay-rates/v1/pay-rates?startDate=${startDate}&endDate=${endDate}&rateType=hourly&isIncludeHistory=true&limit=500`);
  for (const item of findArray(j, ["payRatesByUsers"])) {
    const userId = num(item.userId);
    if (!userId) continue;
    const pr = item.payRate;
    const entries: Json[] = Array.isArray(pr) ? (pr as Json[]) : pr && typeof pr === "object" ? [pr as Json] : [];
    for (const e of entries) {
      const rateType = String(e.rateType ?? "").toLowerCase();
      if (rateType && rateType !== "hourly") continue; // only hourly rates fund per-hour labor cost
      const rate = num(e.defaultRate ?? e.rate ?? e.amount);
      if (rate == null) continue;
      const eff = String(e.effectiveDate ?? "1970-01-01").slice(0, 10);
      map.set(userId, [...(map.get(userId) ?? []), { userId, hourlyRate: rate, effectiveDate: eff }]);
    }
  }
  for (const list of map.values()) list.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  return map;
}

/** The hourly rate applicable to a user ON a date (latest effectiveDate ≤ date). Null if none. */
export function rateForUserOn(rates: Map<number, PayRate[]>, userId: number, date: string): number | null {
  const list = rates.get(userId);
  if (!list || list.length === 0) return null;
  const applicable = list.find((r) => r.effectiveDate <= date);
  return applicable ? applicable.hourlyRate : null; // no rate yet effective on that date → unknown
}

export interface TimeClock {
  id: string;
  name: string;
}
export async function getTimeClocks(): Promise<TimeClock[]> {
  if (!connecteamConfigured()) return [];
  const j = await ctGet("/time-clock/v1/time-clocks");
  return findArray(j, ["timeClocks", "timeClock"])
    .filter((t) => t.isArchived !== true)
    .map((t) => ({ id: String(t.id ?? ""), name: String(t.name ?? "") }));
}

export interface ActualHoursResult {
  ok: boolean;
  /** Paid hours per userId over the range (summed across all time clocks + days). */
  hours: Map<number, number>;
}

export interface PlannedHoursResult {
  ok: boolean;
  hours: Map<number, number>;
}

/** Planned hours per user from SCHEDULED shifts whose local day is in [startYmd,endYmd]. One
 *  range fetch per scheduler (efficient for weeks/months). ok:false when Connecteam is unreachable. */
export async function getPlannedHours(startYmd: string, endYmd: string): Promise<PlannedHoursResult> {
  const hours = new Map<number, number>();
  if (!connecteamConfigured()) return { ok: false, hours };
  const [sy, sm, sd] = startYmd.split("-").map(Number);
  const [ey, em, ed] = endYmd.split("-").map(Number);
  if (!sy || !ey) return { ok: false, hours };
  const from = Date.UTC(sy, sm - 1, sd) / 1000 - 86400;
  const to = Date.UTC(ey, em - 1, ed + 1) / 1000 + 86400;
  const schedulers = await getSchedulers();
  if (schedulers.length === 0) return { ok: false, hours }; // unreachable
  for (const sched of schedulers) {
    const raw = await getShifts(sched, from, to);
    for (const s of raw) {
      const start = Number(s.startTime);
      const end = Number(s.endTime);
      if (!start || !end || end <= start) continue;
      const day = localYmd(start, sched.timezone);
      if (day < startYmd || day > endYmd) continue;
      const h = (end - start) / 3600;
      for (const uid of (s.assignedUserIds as number[] | undefined) ?? []) hours.set(uid, (hours.get(uid) ?? 0) + h);
    }
  }
  return { ok: true, hours };
}

/** Actual paid hours per user for [startDate,endDate] (ISO YYYY-MM-DD, ≤45 days). */
export async function getActualHours(startDate: string, endDate: string): Promise<ActualHoursResult> {
  const hours = new Map<number, number>();
  if (!connecteamConfigured()) return { ok: false, hours };
  const clocks = await getTimeClocks();
  if (clocks.length === 0) return { ok: false, hours }; // unreachable / none configured
  for (const c of clocks) {
    // Confirmed live shape: data.users = [{ userId, dailyRecords:[{date, dailyTotalHours, …}] }].
    const j = await ctGet(`/time-clock/v1/time-clocks/${c.id}/timesheet?startDate=${startDate}&endDate=${endDate}`);
    for (const e of findArray(j, ["users", "employees"])) {
      const uid = num(e.userId);
      if (!uid) continue;
      let h = 0;
      for (const d of (e.dailyRecords as Json[] | undefined) ?? []) h += num(d.dailyTotalHours ?? d.dailyTotalWorkHours) ?? 0;
      hours.set(uid, (hours.get(uid) ?? 0) + h);
    }
  }
  return { ok: true, hours };
}

/** Format a Unix-seconds instant as clock time in `tz` (e.g. "7:30 AM"). */
export function shiftClock(unix: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(unix * 1000));
}
