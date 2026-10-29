import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockUserDays, resetConnecteamRateLimit } from "./connecteam";

// lockUserDays is the ONLY timesheet-finalization write Connecteam exposes (day-locking). These tests pin the
// request shaping, the ≤50/call batching, uniqueness/validation, idempotent no-op, and honest error surfacing
// (incl. the 409 DAYS_IN_APPROVED_PERIOD code) WITHOUT ever touching the live API.

beforeEach(() => {
  process.env.CONNECTEAM_API_KEY = "test-key";
  resetConnecteamRateLimit();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetConnecteamRateLimit();
  delete process.env.CONNECTEAM_API_KEY;
});

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("lockUserDays", () => {
  it("PUTs the lock-days endpoint with dates + isLocked:true and returns ok", async () => {
    const fn = mockFetch(200, {});
    const r = await lockUserDays(55, 123, ["2026-10-06", "2026-10-05"], true);
    expect(r.ok).toBe(true);
    expect(r.dates).toEqual(["2026-10-05", "2026-10-06"]); // deduped + sorted
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/time-clock/v1/time-clocks/55/users/123/lock-days");
    expect(init.method).toBe("PUT");
    const sent = JSON.parse(String(init.body));
    expect(sent.isLocked).toBe(true);
    expect(sent.dates).toEqual(["2026-10-05", "2026-10-06"]);
  });

  it("dedupes + drops non-ISO dates and sorts before sending", async () => {
    const fn = mockFetch(200, {});
    await lockUserDays(1, 2, ["2026-10-05", "2026-10-05", "garbage", "2026-10-01"], true);
    const sent = JSON.parse(String((fn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.dates).toEqual(["2026-10-01", "2026-10-05"]);
  });

  it("batches at most 50 dates per call", async () => {
    const fn = mockFetch(200, {});
    const dates = Array.from({ length: 120 }, (_, i) => `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`);
    const r = await lockUserDays(1, 2, dates, true);
    expect(r.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(3); // 50 + 50 + rest
    for (const call of fn.mock.calls) {
      const sent = JSON.parse(String((call as [string, RequestInit])[1].body));
      expect(sent.dates.length).toBeLessThanOrEqual(50);
    }
  });

  it("is a no-op (no call) when there are no valid dates", async () => {
    const fn = mockFetch(200, {});
    const r = await lockUserDays(1, 2, ["nope"], true);
    expect(r.ok).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it("sends isLocked:false when unlocking and surfaces a 409 DAYS_IN_APPROVED_PERIOD (never crashes)", async () => {
    const fn = mockFetch(409, { errorCode: "DAYS_IN_APPROVED_PERIOD", message: "days in approved period" });
    const r = await lockUserDays(9, 8, ["2026-10-05"], false);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.code).toBe("DAYS_IN_APPROVED_PERIOD");
    const sent = JSON.parse(String((fn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.isLocked).toBe(false);
  });

  it("fails safe (no call) when Connecteam is not configured", async () => {
    delete process.env.CONNECTEAM_API_KEY;
    const fn = mockFetch(200, {});
    const r = await lockUserDays(1, 2, ["2026-10-05"], true);
    expect(r.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
