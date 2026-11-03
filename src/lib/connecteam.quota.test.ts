import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connecteamCallFamily,
  connecteamDownReason,
  formatConnecteamUsage,
  getCrewForDateSafe,
  getUnavailabilityForDate,
  resetConnecteamRateLimit,
  resetConnecteamUsage,
  shiftBlockFor,
  takeConnecteamUsage,
} from "./connecteam";

// The app ran out of Connecteam's 10k/day quota by mid-afternoon because every 14-day sweep read each day
// (and each worker's availability) with its own overlapping ±1-day call. These pin the cheaper read pattern.

const DAY = 86400;
const utcMidnight = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
};
const addDays = (ymd: string, n: number) => new Date((utcMidnight(ymd) + n * DAY) * 1000).toISOString().slice(0, 10);

type Res = { ok: boolean; status: number; headers: Headers; json: () => Promise<unknown> };
const res = (status: number, body: unknown, headers: Record<string, string> = {}): Res => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => body,
});

beforeEach(() => {
  process.env.CONNECTEAM_API_KEY = "test-key";
  resetConnecteamRateLimit();
  resetConnecteamUsage();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetConnecteamRateLimit();
  resetConnecteamUsage();
  delete process.env.CONNECTEAM_API_KEY;
});

describe("shiftBlockFor", () => {
  it("puts the days of one week in the same chunk, padded a day each side", () => {
    const first = shiftBlockFor(utcMidnight("2030-01-03")); // epoch-aligned chunks start on a Thursday
    for (let i = 0; i < 7; i++) {
      const day = utcMidnight(addDays("2030-01-03", i));
      const b = shiftBlockFor(day);
      expect(b.key).toBe(first.key);
      expect(b.from).toBeLessThanOrEqual(day - DAY);
      expect(b.to).toBeGreaterThanOrEqual(day + 2 * DAY);
    }
    expect(shiftBlockFor(utcMidnight("2030-01-10")).key).toBe(first.key + 1);
  });
});

describe("crew reads share weekly chunks", () => {
  it("a 14-day sweep reads shifts at most 3 times and still files each shift on its own day", async () => {
    const start = "2031-03-01";
    // One 2pm ET shift on each of the 14 days.
    const shifts = Array.from({ length: 14 }, (_, i) => ({
      id: `s${i}`,
      startTime: utcMidnight(addDays(start, i)) + 19 * 3600,
      endTime: utcMidnight(addDays(start, i)) + 23 * 3600,
      assignedUserIds: [1],
    }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/shifts")) {
        const q = new URL(url).searchParams;
        const from = Number(q.get("startTime"));
        const to = Number(q.get("endTime"));
        return res(200, { data: { shifts: shifts.filter((s) => s.startTime >= from && s.startTime <= to) } });
      }
      if (url.includes("/users/v1/users")) return res(200, { data: { users: [{ userId: 1, firstName: "Ana", lastName: "Driver" }] } });
      if (url.includes("/scheduler/v1/schedulers")) return res(200, { data: { schedulers: [{ schedulerId: 7, name: "Main", timezone: "America/New_York" }] } });
      return res(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 14; i++) {
      const date = addDays(start, i);
      const r = await getCrewForDateSafe(date);
      expect(r.ok).toBe(true);
      expect(r.shifts.map((s) => s.id)).toEqual([`s${i}`]);
    }
    const shiftCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/shifts")).length;
    expect(shiftCalls).toBeLessThanOrEqual(3);
  });

  it("a failed chunk read is unverified, not an empty day", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/shifts")) return res(500, {});
        if (url.includes("/users/v1/users")) return res(200, { data: { users: [{ userId: 1, firstName: "Ana" }] } });
        if (url.includes("/scheduler/v1/schedulers")) return res(200, { data: { schedulers: [{ schedulerId: 8, name: "Main", timezone: "America/New_York" }] } });
        return res(404, {});
      }),
    );
    expect((await getCrewForDateSafe("2032-05-05")).ok).toBe(false);
  });
});

describe("availability reads share weekly chunks", () => {
  it("one call per worker covers every day of the week, and each day only sees its own blocks", async () => {
    const day = "2033-06-02"; // a Thursday, so the whole week is one chunk
    const blockStart = utcMidnight(day) + 13 * 3600; // 9am ET
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("user-unavailability")) {
        const uid = Number(new URL(url).searchParams.get("userId"));
        // Worker 1 is off 9am-3pm on `day` only.
        const list = uid === 1 ? [{ type: "unavailability", startTime: { timestamp: blockStart }, endTime: { timestamp: blockStart + 6 * 3600 }, note: "class" }] : [];
        return res(200, { data: { userUnavailabilities: [{ userId: uid, unavailabilities: list, shifts: [] }] } });
      }
      return res(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const sameDay = await getUnavailabilityForDate(day, [1, 2]);
    expect(sameDay.ok).toBe(true);
    expect(sameDay.byUser.get(1)?.[0].reason).toBe("class");
    expect(sameDay.byUser.has(2)).toBe(false);

    const later = await getUnavailabilityForDate(addDays(day, 4), [1, 2]);
    expect(later.ok).toBe(true);
    expect(later.byUser.size).toBe(0); // the block is outside that day's window

    for (let i = 1; i < 7; i++) await getUnavailabilityForDate(addDays(day, i), [1, 2]);
    const calls = fetchMock.mock.calls.filter(([u]) => String(u).includes("user-unavailability")).length;
    expect(calls).toBe(2); // one per worker for the whole week
  });
});

describe("quota meter", () => {
  it("counts calls by endpoint family, remembers the day's remaining quota, and resets on take", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res(200, { data: { userUnavailabilities: [] } }, { "x-ratelimit-day-remaining": "1800", "x-ratelimit-day-limit": "10000" })),
    );
    await getUnavailabilityForDate("2034-07-06", [11, 12, 13]);
    const u = takeConnecteamUsage();
    expect(u.calls).toBe(3);
    expect(u.byFamily[0]).toEqual({ family: "/scheduler/v1/schedulers/user-unavailability", calls: 3 });
    expect(u.dayRemaining).toBe(1800);
    expect(u.dayLimit).toBe(10000);
    expect(u.conserving).toBe(true); // under the 2500 default
    expect(formatConnecteamUsage(u)).toBe("3 calls since last tick (user-unavailability 3), 1,800 left today (conserving)");
    expect(takeConnecteamUsage().calls).toBe(0);
  });

  it("collapses ids in the family name", () => {
    expect(connecteamCallFamily("/scheduler/v1/schedulers/11594873/shifts?startTime=1&endTime=2")).toBe("/scheduler/v1/schedulers/:id/shifts");
  });

  it("says the daily limit is spent instead of 'unreachable' while backing off a 429", async () => {
    expect(connecteamDownReason()).toBe("Connecteam unreachable");
    vi.stubGlobal("fetch", vi.fn(async () => res(429, {}, { "retry-after": "600" })));
    await getUnavailabilityForDate("2035-08-02", [21]);
    expect(connecteamDownReason()).toMatch(/^Connecteam daily API limit reached, resumes \d{1,2}:\d{2} [AP]M ET$/);
  });
});
