import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusAlert } from "./status";

// Mock the status poster so no network is touched and we can inspect the cards.
const posted: StatusAlert[] = [];
const postStatus = vi.fn(async (a: StatusAlert) => {
  posted.push(a);
  return { ok: true };
});
vi.mock("./status", async (orig) => ({ ...(await orig<typeof import("./status")>()), postStatus: (a: StatusAlert) => postStatus(a) }));

describe("alertOps", () => {
  beforeEach(() => {
    postStatus.mockClear();
    posted.length = 0;
    // Reset throttle state per test. The module captures this map by reference at
    // import, so clear it IN PLACE (replacing the global would leave the module's
    // reference pointing at the old, un-cleared map).
    const g = globalThis as { __opsAlertSeen?: Map<string, number> };
    (g.__opsAlertSeen ??= new Map()).clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("posts a readable status card, not a dump", async () => {
    const { alertOps } = await import("./alert");
    await alertOps("SMS (Quo/OpenPhone)", "to +15551234567: openphone 401");
    expect(postStatus).toHaveBeenCalledTimes(1);
    const a = posted[0];
    expect(a.system).toBe("Quo texting");
    expect(a.title).toBe("Quo texting rejected our login or API key");
    expect(a.impact).toMatch(/Customer texts/);
    expect(a.detail).toContain("openphone 401");
  });

  it("names a rate limit as a rate limit", async () => {
    const { alertOps } = await import("./alert");
    await alertOps("Google Maps (directions)", "OVER_QUERY_LIMIT: You have exceeded your daily request quota");
    expect(posted[0].title).toBe("Google Maps is rate limited");
    expect(posted[0].level).toBe("degraded");
  });

  it("throttles repeat failures of the same kind to one post per window", async () => {
    const { alertOps } = await import("./alert");
    await alertOps("GPS TrackIt (Zonar)", "unit NPR-1: HTTP 403");
    await alertOps("GPS TrackIt (Zonar)", "unit NPR-1: HTTP 403");
    await alertOps("GPS TrackIt (Zonar)", "unit NPR-2: HTTP 403"); // another truck, same outage
    expect(postStatus).toHaveBeenCalledTimes(1);
  });

  it("still posts when the failure kind differs", async () => {
    const { alertOps } = await import("./alert");
    await alertOps("GPS TrackIt (Zonar)", "unit NPR-1: HTTP 403");
    await alertOps("GPS TrackIt (Zonar)", "unit NPR-2: HTTP 500");
    expect(postStatus).toHaveBeenCalledTimes(2);
  });

  it("never throws even if posting rejects", async () => {
    postStatus.mockRejectedValueOnce(new Error("boom"));
    const { alertOps } = await import("./alert");
    await expect(alertOps("fan-out", "kaboom")).resolves.toBeUndefined();
  });
});
