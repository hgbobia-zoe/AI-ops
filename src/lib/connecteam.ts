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

export interface CrewMember {
  userId: number;
  name: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  userType?: string;
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
    map.set(userId, {
      userId,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim() || `#${userId}`,
      phone: u.phoneNumber as string | undefined,
      email: u.email as string | undefined,
      userType: u.userType as string | undefined,
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

/**
 * Crew shifts for a calendar day (YYYY-MM-DD). Fetches a padded window (±1 day, to cover
 * any timezone), then keeps shifts whose local start-day matches, with assignee names
 * resolved. Sorted by start time. Empty when Connecteam isn't configured.
 */
export async function getCrewForDate(date: string): Promise<CrewShift[]> {
  if (!connecteamConfigured()) return [];
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return [];
  const dayStartUtc = Date.UTC(y, m - 1, d) / 1000;
  const from = dayStartUtc - 86400; // pad ±1 day for tz spread
  const to = dayStartUtc + 2 * 86400;

  const [users, schedulers] = await Promise.all([getUsers(), getSchedulers()]);
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
        assignees: ids.map((id) => users.get(id) ?? { userId: id, name: `#${id}` }),
      });
    }
  }
  out.sort((a, b) => a.startUnix - b.startUnix);
  return out;
}

/** Format a Unix-seconds instant as clock time in `tz` (e.g. "7:30 AM"). */
export function shiftClock(unix: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(unix * 1000));
}
