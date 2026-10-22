import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTimeClocks,
  refreshConnecteamHealth,
  connecteamRateLimited,
  resetConnecteamRateLimit,
} from "./connecteam";

// The outage this guards against: Connecteam's limits are PER ACCOUNT (Expert = 100/min AND 10,000/day).
// When the DAILY cap drains, EVERY call 429s until the UTC day resets (verified live: day-remaining 0,
// minute-remaining fine). The old client didn't cache 429s and retried them 400ms later, so every render
// re-fired — a stampede that drained the quota and then hammered a 429 wall. The breaker must: arm from the
// quota headers, NOT retry a 429, and suppress further live calls until the reported reset.
//
// We drive the breaker through getTimeClocks() specifically because it is NOT TTL-cached (so each test case
// exercises a real ctGet without a prior success leaking in from the module-level read caches).

const KEY = "test-key";

/** A minimal fetch Response stub with a header bag (names matched case-insensitively, like a real Headers). */
function resp(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const inAnHour = () => String(Math.floor(Date.now() / 1000) + 3600);

beforeEach(() => {
  process.env.CONNECTEAM_API_KEY = KEY;
  resetConnecteamRateLimit();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetConnecteamRateLimit();
  delete process.env.CONNECTEAM_API_KEY;
});

describe("Connecteam rate-limit breaker", () => {
  it("arms on a 429, does NOT retry it, and suppresses further live calls until reset", async () => {
    const fetchMock = vi.fn(async () =>
      resp(429, { detail: "Too many requests" }, {
        "x-ratelimit-day-remaining": "0",
        "x-ratelimit-day-reset": inAnHour(),
        "x-ratelimit-minute-remaining": "81",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await getTimeClocks(); // honest empty (never "there are no time clocks")
    expect(first).toEqual([]);
    expect(connecteamRateLimited()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the 429 is NOT retried (old code fired a 2nd 400ms later)

    const second = await getTimeClocks(); // gated: served without touching the network
    expect(second).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still 1 — no stampede while backing off
  });

  it("arms PREEMPTIVELY on a 200 whose day quota is spent (before the next call would 429)", async () => {
    const fetchMock = vi.fn(async () =>
      resp(200, { data: { timeClocks: [{ id: "tc1", name: "Main" }] } }, {
        "x-ratelimit-day-remaining": "0",
        "x-ratelimit-day-reset": inAnHour(),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const clocks = await getTimeClocks();
    expect(clocks.map((c) => c.id)).toEqual(["tc1"]); // the successful read still returns its data
    expect(connecteamRateLimited()).toBe(true); // ...and the breaker is armed so the NEXT call doesn't 429
  });

  it("does NOT arm on an ordinary success with headroom", async () => {
    const fetchMock = vi.fn(async () =>
      resp(200, { data: { timeClocks: [{ id: "tc1", name: "Main" }] } }, {
        "x-ratelimit-day-remaining": "9000",
        "x-ratelimit-minute-remaining": "95",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getTimeClocks();
    expect(connecteamRateLimited()).toBe(false);
  });

  it("reports health as rate-limited (not unreachable) while backing off", async () => {
    // Arm the breaker via a 429, then prove the health probe degrades honestly WITHOUT another network call.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resp(429, { detail: "Too many requests" }, { "x-ratelimit-day-remaining": "0", "x-ratelimit-day-reset": inAnHour() })),
    );
    await getTimeClocks();
    expect(connecteamRateLimited()).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no live call expected while rate-limited");
      }),
    );
    const h = await refreshConnecteamHealth();
    expect(h.ok).toBe(false);
    expect(h.rateLimited).toBe(true);
    expect(h.detail).toMatch(/rate-limited/i);
  });

  it("resetConnecteamRateLimit clears the breaker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(429, {}, { "x-ratelimit-day-remaining": "0", "x-ratelimit-day-reset": inAnHour() })));
    await getTimeClocks();
    expect(connecteamRateLimited()).toBe(true);
    resetConnecteamRateLimit();
    expect(connecteamRateLimited()).toBe(false);
  });
});
