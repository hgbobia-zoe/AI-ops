import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCrewForDateSafe, getPlannedHours, resetConnecteamRateLimit } from "./connecteam";

// A failed shift read must come back as "couldn't check" (ok:false), never as "nobody is scheduled".
// Treating a rate-limited read as an empty schedule made the risk scan flag every staffing risk as back,
// then clear them minutes later, every hour in #delivery-updates.

beforeEach(() => {
  process.env.CONNECTEAM_API_KEY = "test-key";
  resetConnecteamRateLimit();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetConnecteamRateLimit();
  delete process.env.CONNECTEAM_API_KEY;
});

function mockConnecteam(shiftsStatus: number, shifts: unknown[] = []) {
  const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/shifts")) return res(shiftsStatus, { data: { shifts } });
      if (url.includes("/users/v1/users")) return res(200, { data: { users: [{ userId: 1, firstName: "Ana", lastName: "Driver" }] } });
      if (url.includes("/scheduler/v1/schedulers")) return res(200, { data: { schedulers: [{ schedulerId: 5, name: "Main", timezone: "America/New_York" }] } });
      return res(404, {});
    }),
  );
}

describe("Connecteam shift reads", () => {
  it("a failed shift read is unverified, not an empty day", async () => {
    mockConnecteam(500);
    const r = await getCrewForDateSafe("2026-11-06");
    expect(r.ok).toBe(false);
  });

  it("a successful read of an empty day is a verified empty day", async () => {
    mockConnecteam(200, []);
    const r = await getCrewForDateSafe("2026-11-07");
    expect(r).toEqual({ ok: true, shifts: [] });
  });

  it("planned hours report unreachable instead of zero hours", async () => {
    mockConnecteam(500);
    const r = await getPlannedHours("2026-11-08", "2026-11-09");
    expect(r.ok).toBe(false);
  });
});
