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

/** One GET attempt. `transient` marks a failure worth retrying (network error, timeout, or a 5xx/429
 *  from Connecteam) vs. a definitive one (bad key / 4xx) that a retry can't fix. */
async function ctGetOnce(path: string, timeoutMs: number): Promise<{ json: unknown | null; transient: boolean }> {
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
      return { json: null, transient: res.status >= 500 || res.status === 429 };
    }
    return { json: await res.json(), transient: false };
  } catch (e) {
    console.error("[connecteam] error", path, String(e));
    return { json: null, transient: true }; // abort/timeout/network — a single slow response shouldn't count as "down"
  } finally {
    clearTimeout(t);
  }
}

async function ctGet(path: string, timeoutMs = 12000): Promise<unknown | null> {
  if (!connecteamConfigured()) return null;
  let r = await ctGetOnce(path, timeoutMs);
  if (r.json === null && r.transient) {
    await new Promise((res) => setTimeout(res, 400));
    r = await ctGetOnce(path, timeoutMs); // one retry — a lone timeout/blip must not read as unreachable
  }
  return r.json;
}

// ── Live reachability (single source of truth for the status dots) ───────────────────────────────
// The top status bar and the Connections dashboard used to read Connecteam health off the import
// ledger — a row the risk scan writes — so a single "unreachable during scan" left a stale red dot
// long after Connecteam was fine, and the two surfaces could disagree. This TTL-cached, single-flight
// probe is the one live signal both now read, so they can never diverge and a stale ledger row can't
// fabricate a failure.

export interface ConnecteamHealth {
  ok: boolean;
  checkedAt: string; // ISO of the probe
  detail: string;
}

const CT_HEALTH_TTL_MS = 90_000; // at most one real probe per 90s, however often either surface renders
let _ctHealth: ConnecteamHealth | null = null;
let _ctInflight: Promise<ConnecteamHealth> | null = null;

/** The last live reachability result, or null if we haven't probed yet this process. Synchronous, so
 *  the (sync) health computations can read it without changing their signatures. */
export function connecteamHealthCached(): ConnecteamHealth | null {
  return _ctHealth;
}

/** Refresh the live reachability probe, TTL-cached + single-flight: a fresh cached result short-circuits,
 *  concurrent callers share one in-flight probe, and it never throws. Call this from an async surface
 *  (layout / API route) before reading health; the sync `connecteamHealthCached()` then reflects it. */
export async function refreshConnecteamHealth(now: number = Date.now()): Promise<ConnecteamHealth> {
  if (!connecteamConfigured()) {
    _ctHealth = { ok: false, checkedAt: new Date(now).toISOString(), detail: "not connected" };
    return _ctHealth;
  }
  if (_ctHealth && now - Date.parse(_ctHealth.checkedAt) < CT_HEALTH_TTL_MS) return _ctHealth;
  if (_ctInflight) return _ctInflight;
  _ctInflight = (async () => {
    // One cheap call (no pagination); ctGet already retries a transient miss once.
    const j = (await ctGet("/scheduler/v1/schedulers")) as SchedResp | null;
    const ok = j != null && Array.isArray(j.data?.schedulers);
    return { ok, checkedAt: new Date().toISOString(), detail: ok ? "reachable" : "unreachable" } as ConnecteamHealth;
  })()
    .catch(() => ({ ok: false, checkedAt: new Date().toISOString(), detail: "unreachable" }) as ConnecteamHealth)
    .then((h) => {
      _ctHealth = h;
      _ctInflight = null;
      return h;
    });
  return _ctInflight;
}

// ── TTL + single-flight read cache ────────────────────────────────────────────────────────────────
// Every SSR page (dashboard, scheduling, dispatch, risk) re-reads users/schedulers/crew on each render,
// and getCrewForDateSafe re-reads users+schedulers internally — so ONE page load fired a dozen Connecteam
// round-trips and took seconds (measured: /dashboard ~4s, /scheduling ~3s TTFB, all server-side). These
// caches dedupe identical reads for a short TTL. Single Fly machine (per fly.toml) → a module-level cache
// is shared across requests. Staleness is bounded and matches the app's existing freshness posture (health
// 90s, runtime tick 15m). A failed/empty result is NOT cached (via `cacheable`), so a transient outage is
// never pinned as "nobody scheduled". Single-flight collapses concurrent identical reads into one call.
function ttlCache<T>(ttlMs: number, cacheable: (v: T) => boolean) {
  const store = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();
  return (key: string, fetchFn: () => Promise<T>): Promise<T> => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    const flying = inflight.get(key);
    if (flying) return flying;
    const p = fetchFn()
      .then((value) => {
        if (cacheable(value)) store.set(key, { at: Date.now(), value });
        inflight.delete(key);
        return value;
      })
      .catch((e) => {
        inflight.delete(key);
        throw e;
      });
    inflight.set(key, p);
    return p;
  };
}

const _usersCache = ttlCache<Map<number, CrewMember>>(5 * 60_000, (m) => m.size > 0);
const _schedCache = ttlCache<Scheduler[]>(5 * 60_000, (l) => l.length > 0);
const _crewCache = ttlCache<CrewDayResult>(60_000, (r) => r.ok);
const _ratesCache = ttlCache<Map<number, PayRate[]>>(5 * 60_000, (m) => m.size > 0);
const _plannedCache = ttlCache<PlannedHoursResult>(5 * 60_000, (r) => r.ok);
const _actualCache = ttlCache<ActualHoursResult>(5 * 60_000, (r) => r.ok);

/** Fetch ALL pages of a Connecteam list endpoint (they cap at a page size, so a single call
 *  silently truncates). Dedup-terminated: stops on a short page OR when a page adds nothing new —
 *  so it can't loop even if the endpoint ignores `offset` (worst case = today's single-page behavior). */
async function ctGetAllPages<T>(base: string, extract: (j: unknown) => T[], keyOf: (t: T) => string | number, pageSize = 200): Promise<T[]> {
  const seen = new Set<string | number>();
  const out: T[] = [];
  const sep = base.includes("?") ? "&" : "?";
  for (let offset = 0, guard = 0; guard < 100; guard++, offset += pageSize) {
    const j = await ctGet(`${base}${sep}offset=${offset}&limit=${pageSize}`);
    if (!j) break;
    const page = extract(j);
    let added = 0;
    for (const it of page) {
      const k = keyOf(it);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(it);
        added++;
      }
    }
    if (page.length < pageSize || added === 0) break;
  }
  return out;
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

/** The team, keyed by userId (name resolved from first/last). TTL-cached (5m) — the roster barely changes
 *  and it's re-read on every page + inside every getCrewForDateSafe. */
export async function getUsers(): Promise<Map<number, CrewMember>> {
  if (!connecteamConfigured()) return new Map();
  return _usersCache("users", getUsersUncached);
}
async function getUsersUncached(): Promise<Map<number, CrewMember>> {
  const users = await ctGetAllPages<Record<string, unknown>>(
    "/users/v1/users",
    (j) => ((j as UsersResp)?.data?.users ?? []) as Record<string, unknown>[],
    (u) => Number(u.userId),
  );
  const map = new Map<number, CrewMember>();
  for (const u of users) {
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

/** The team as a flat array (empty when unconfigured/unreachable). For crew suggestions. */
export async function getUsersList(): Promise<CrewMember[]> {
  return Array.from((await getUsers()).values());
}

export async function getSchedulers(): Promise<Scheduler[]> {
  if (!connecteamConfigured()) return [];
  return _schedCache("schedulers", getSchedulersUncached);
}
async function getSchedulersUncached(): Promise<Scheduler[]> {
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
  return ctGetAllPages<Record<string, unknown>>(
    `/scheduler/v1/schedulers/${sched.schedulerId}/shifts?startTime=${startUnix}&endTime=${endUnix}`,
    (j) => ((j as ShiftsResp)?.data?.shifts ?? []) as Record<string, unknown>[],
    (s) => String(s.id ?? `${s.userId}|${s.startTime}|${s.endTime}`),
  );
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
  return _crewCache(`crew:${date}`, () => getCrewForDateSafeUncached(date));
}
async function getCrewForDateSafeUncached(date: string): Promise<CrewDayResult> {
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

// ── Availability: the REAL "is this worker free?" signal ──────────────────────────────────────────
// Connecteam exposes a per-user endpoint that returns the worker's own time-off + unavailability (what
// they marked in their Connecteam app) AND their existing shifts, in one call:
//   GET /scheduler/v1/schedulers/user-unavailability?userId=&startTime=&endTime=   (Unix SECONDS)
// Entries carry type "timeOff" (approved time off, with policyName) or "unavailability" (worker-set,
// with note); each has startTime/endTime as {unix/ts + timezone}. This is the signal we were blind to —
// without it the scheduler could propose someone who marked themselves off. Same /scheduler/v1 scope as
// the shift reads, so it rides the same API access. Never throws; ok:false when unreachable (so an outage
// is NEVER mistaken for "freely available" — that would be the exact bug we're trying to kill).

export type UnavailabilityKind = "unavailability" | "timeOff";

export interface UnavailabilityBlock {
  userId: number;
  kind: UnavailabilityKind;
  startUnix: number;
  endUnix: number;
  /** Worker's note (unavailability) or the time-off policy name (timeOff). */
  reason?: string;
}

export interface UnavailabilityResult {
  /** True only when Connecteam actually answered. When false, availability is UNKNOWN — callers must
   *  NOT treat an empty block list as "available". */
  ok: boolean;
  blocks: UnavailabilityBlock[];
}

/** Coerce a timestamp that may be a bare Unix number or an object ({unix}/{timestamp}/{seconds}/{time}). */
function unixOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return num(o.unix ?? o.timestamp ?? o.seconds ?? o.time ?? o.epoch);
  }
  return null;
}

/**
 * A user's time-off + unavailability blocks over [startUnix,endUnix]. Shape-tolerant: it walks the
 * response for any entry carrying type "timeOff"/"unavailability" (shift assignments have no such type,
 * so they're skipped), so a minor nesting change in Connecteam's payload can't silently drop blocks.
 */
export async function getUserUnavailability(userId: number, startUnix: number, endUnix: number): Promise<UnavailabilityResult> {
  if (!connecteamConfigured()) return { ok: false, blocks: [] };
  const j = await ctGet(`/scheduler/v1/schedulers/user-unavailability?userId=${userId}&startTime=${startUnix}&endTime=${endUnix}`);
  if (j == null) return { ok: false, blocks: [] };
  const blocks: UnavailabilityBlock[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const it of node) visit(it);
      return;
    }
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      const t = String(o.type ?? "").trim();
      if (t === "timeOff" || t === "unavailability") {
        const s = unixOf(o.startTime ?? o.start);
        const e = unixOf(o.endTime ?? o.end);
        if (s && e) {
          const reason = typeof o.note === "string" ? o.note : typeof o.policyName === "string" ? o.policyName : undefined;
          blocks.push({ userId, kind: t, startUnix: s, endUnix: e, reason });
        }
        return; // don't descend into a block we've captured
      }
      for (const v of Object.values(o)) visit(v);
    }
  };
  visit(j);
  return { ok: true, blocks };
}

/**
 * Unavailability for a set of users on a calendar day (pads ±1 day for tz spread). One call per user
 * (the endpoint is per-user). ok is true if ANY user resolved — so a single user's blip doesn't void the
 * whole day — and byUser only holds users who actually have blocks. Intended for the candidate pool, not
 * the whole company.
 */
export async function getUnavailabilityForDate(
  date: string,
  userIds: number[],
): Promise<{ ok: boolean; byUser: Map<number, UnavailabilityBlock[]> }> {
  const byUser = new Map<number, UnavailabilityBlock[]>();
  if (!connecteamConfigured() || userIds.length === 0) return { ok: false, byUser };
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return { ok: false, byUser };
  const base = Date.UTC(y, m - 1, d) / 1000;
  const from = base - 86400;
  const to = base + 2 * 86400;
  let anyOk = false;
  for (const uid of userIds) {
    const r = await getUserUnavailability(uid, from, to);
    if (r.ok) {
      anyOk = true;
      if (r.blocks.length) byUser.set(uid, r.blocks);
    }
  }
  return { ok: anyOk, byUser };
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
  if (!connecteamConfigured()) return new Map();
  return _ratesCache(`rates:${startDate}:${endDate}`, () => getPayRatesUncached(startDate, endDate));
}
async function getPayRatesUncached(startDate: string, endDate: string): Promise<Map<number, PayRate[]>> {
  const map = new Map<number, PayRate[]>();
  if (!connecteamConfigured()) return map;
  // Confirmed shape (live probe): data.payRatesByUsers = [{ userId, payRate }], where payRate is
  // an object (or array w/ history) of { effectiveDate, rateType, defaultRate, resourcesRates, … }.
  const items = await ctGetAllPages<Json>(
    `/pay-rates/v1/pay-rates?startDate=${startDate}&endDate=${endDate}&rateType=hourly&isIncludeHistory=true`,
    (j) => findArray(j, ["payRatesByUsers"]),
    (it) => Number((it as Record<string, unknown>).userId),
  );
  for (const item of items) {
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
  if (!connecteamConfigured()) return { ok: false, hours: new Map() };
  return _plannedCache(`planned:${startYmd}:${endYmd}`, () => getPlannedHoursUncached(startYmd, endYmd));
}
async function getPlannedHoursUncached(startYmd: string, endYmd: string): Promise<PlannedHoursResult> {
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
  if (!connecteamConfigured()) return { ok: false, hours: new Map() };
  return _actualCache(`actual:${startDate}:${endDate}`, () => getActualHoursUncached(startDate, endDate));
}
async function getActualHoursUncached(startDate: string, endDate: string): Promise<ActualHoursResult> {
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

// ── Shift WRITE: publish a schedule the app built back into Connecteam ────────────────────────────
// The scheduling blade builds shifts in-app; this pushes an approved one into Connecteam as a PUBLISHED
// shift so the assigned crew are notified. Create endpoint (verified from Connecteam's API reference):
//   POST /scheduler/v1/schedulers/{schedulerId}/shifts?notifyUsers=true
//   body: an ARRAY of shift objects; each needs title (or jobId), startTime+endTime (Unix SECONDS) and
//   timezone; isPublished=true + notifyUsers=true alerts the assigned users. Never throws.

/** One write attempt (POST/PUT; mirrors ctGetOnce). `transient` = worth retrying (network/timeout/5xx/429). */
async function ctWriteOnce(
  method: "POST" | "PUT",
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ json: unknown | null; status: number; transient: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "X-API-KEY": process.env.CONNECTEAM_API_KEY!, accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      console.error("[connecteam]", method, path, "HTTP", res.status);
      return { json, status: res.status, transient: res.status >= 500 || res.status === 429 };
    }
    return { json, status: res.status, transient: false };
  } catch (e) {
    console.error("[connecteam]", method, "error", path, String(e));
    return { json: null, status: 0, transient: true };
  } finally {
    clearTimeout(t);
  }
}

/** Write with one retry on a transient failure. */
async function ctWrite(method: "POST" | "PUT", path: string, body: unknown): Promise<{ json: unknown | null; status: number }> {
  let r = await ctWriteOnce(method, path, body, 12000);
  if (r.json === null && r.transient) {
    await new Promise((res) => setTimeout(res, 400));
    r = await ctWriteOnce(method, path, body, 12000);
  }
  return { json: r.json, status: r.status };
}

/**
 * Pick the scheduler to publish into. Honors CONNECTEAM_SCHEDULER_ID; else the only one; else one named
 * like "Job"/"Schedule"; else the first. Null when Connecteam is unreachable / has no scheduler.
 */
export async function getDefaultScheduler(): Promise<Scheduler | null> {
  const list = await getSchedulers();
  if (list.length === 0) return null;
  const envId = Number(process.env.CONNECTEAM_SCHEDULER_ID);
  if (envId) return list.find((s) => s.schedulerId === envId) ?? null;
  if (list.length === 1) return list[0];
  return list.find((s) => /job|schedul/i.test(s.name)) ?? list[0];
}

export interface PublishShiftInput {
  schedulerId: number;
  title: string;
  startUnix: number;
  endUnix: number;
  timezone: string;
  assignedUserIds: number[];
}

export interface PublishShiftResult {
  ok: boolean;
  shiftId?: string;
  error?: string;
}

/** The shift object both create (POST) and update (PUT) send; update adds `id`. */
function shiftBody(input: PublishShiftInput, id?: string): Record<string, unknown> {
  const o: Record<string, unknown> = {
    title: input.title.slice(0, 120),
    startTime: input.startUnix,
    endTime: input.endUnix,
    timezone: input.timezone,
    isPublished: true,
    isOpenShift: input.assignedUserIds.length === 0,
    assignedUserIds: input.assignedUserIds,
  };
  if (id) o.id = /^\d+$/.test(id) ? Number(id) : id;
  return o;
}

function validatePublishInput(input: PublishShiftInput): string | null {
  if (!connecteamConfigured()) return "Connecteam not configured";
  if (!input.title.trim()) return "shift title required";
  if (!input.startUnix || !input.endUnix || input.endUnix <= input.startUnix) return "invalid time window";
  return null;
}

/**
 * Create a PUBLISHED shift in Connecteam and notify the assigned crew. Reports ok ONLY when Connecteam
 * actually accepted it and returned a shift — never fakes success. One retry on a transient failure.
 */
export async function createPublishedShift(input: PublishShiftInput): Promise<PublishShiftResult> {
  const bad = validatePublishInput(input);
  if (bad) return { ok: false, error: bad };
  const path = `/scheduler/v1/schedulers/${input.schedulerId}/shifts?notifyUsers=true`;
  const r = await ctWrite("POST", path, [shiftBody(input)]);
  if (r.status !== 200 && r.status !== 201) {
    return { ok: false, error: extractErr(r.json) || `Connecteam HTTP ${r.status || "error"}` };
  }
  return { ok: true, shiftId: extractCreatedShiftId(r.json) };
}

/**
 * Update an already-published Connecteam shift in place (collection-level PUT, id in the body) and
 * re-notify the crew. Used when a sent shift is edited and re-published. Honest: ok only on a real 2xx.
 * NOTE: the PUT body shape is inferred from the create schema + an `id`; on a shape mismatch Connecteam
 * returns a 4xx which we surface (no corruption — the dispatcher can adjust in Connecteam).
 */
export async function updatePublishedShift(input: PublishShiftInput & { shiftId: string }): Promise<PublishShiftResult> {
  const bad = validatePublishInput(input);
  if (bad) return { ok: false, error: bad };
  const path = `/scheduler/v1/schedulers/${input.schedulerId}/shifts?notifyUsers=true`;
  const r = await ctWrite("PUT", path, [shiftBody(input, input.shiftId)]);
  if (r.status !== 200 && r.status !== 201) {
    return { ok: false, error: extractErr(r.json) || `Connecteam HTTP ${r.status || "error"}` };
  }
  return { ok: true, shiftId: input.shiftId };
}

export interface SetPayRateResult {
  ok: boolean;
  status?: number;
  error?: string;
}
/** Upsert a worker's HOURLY pay rate into Connecteam (PUT /pay-rates/v1/pay-rates). Needs the
 *  `pay_rates.write` scope on the API key. Honest: ok only on a real 2xx; surfaces Connecteam's error —
 *  e.g. HAS_LOCKED_DAYS (effectiveDate on/after a locked timesheet day) or a 403 when the key lacks write
 *  scope. The body mirrors the read shape (payRatesByUsers[].payRate.defaultRate + effectiveDate + rateType). */
export async function setConnecteamPayRate(userId: number, hourlyRate: number, effectiveDate: string): Promise<SetPayRateResult> {
  if (!connecteamConfigured()) return { ok: false, error: "Connecteam not configured" };
  if (!(hourlyRate >= 0)) return { ok: false, error: "invalid rate" };
  const body = { payRatesByUsers: [{ userId, payRate: { defaultRate: hourlyRate, effectiveDate, isDefaultRateEnabled: true, rateType: "hourly" } }] };
  const r = await ctWrite("PUT", "/pay-rates/v1/pay-rates", body);
  if (r.status !== 200 && r.status !== 201) return { ok: false, status: r.status, error: extractErr(r.json) || `Connecteam HTTP ${r.status || "error"}` };
  return { ok: true, status: r.status };
}

/** Best-effort pull of the created shift id from Connecteam's (loosely documented) response shape. */
function extractCreatedShiftId(json: unknown): string | undefined {
  const shifts = findArray(json, ["shifts"]);
  const first = shifts[0] as Record<string, unknown> | undefined;
  const id = first?.id ?? (json as { data?: { id?: unknown } })?.data?.id;
  return id != null ? String(id) : undefined;
}

/** Pull a human error message out of a Connecteam error body, if any. */
function extractErr(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const m = o.message ?? o.error ?? (o.data as Record<string, unknown> | undefined)?.message;
  return typeof m === "string" ? m : null;
}
