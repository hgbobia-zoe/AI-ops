import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Slack transport so no network is touched and we can count posts.
const slackNotify = vi.fn(async () => ({ ok: true }));
vi.mock("./slack", () => ({ slackNotify: (t: string) => slackNotify(t) }));

describe("alertOps", () => {
  beforeEach(() => {
    slackNotify.mockClear();
    // Reset throttle state per test. The module captures this map by reference at
    // import, so clear it IN PLACE (replacing the global would leave the module's
    // reference pointing at the old, un-cleared map).
    const g = globalThis as { __opsAlertSeen?: Map<string, number> };
    (g.__opsAlertSeen ??= new Map()).clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("posts a failure to Slack", async () => {
    const { alertOps } = await import("./alert");
    await alertOps("SMS (Quo/OpenPhone)", "to +15551234567: openphone 401");
    expect(slackNotify).toHaveBeenCalledTimes(1);
    expect(slackNotify.mock.calls[0][0]).toContain("SMS (Quo/OpenPhone)");
    expect(slackNotify.mock.calls[0][0]).toContain("openphone 401");
  });

  it("throttles identical failures to one post per window", async () => {
    const { alertOps } = await import("./alert");
    await alertOps("GPS TrackIt (Zonar)", "unit NPR-1: HTTP 403");
    await alertOps("GPS TrackIt (Zonar)", "unit NPR-1: HTTP 403");
    await alertOps("GPS TrackIt (Zonar)", "unit NPR-1: HTTP 403");
    expect(slackNotify).toHaveBeenCalledTimes(1);
  });

  it("still posts when the detail differs", async () => {
    const { alertOps } = await import("./alert");
    await alertOps("GPS TrackIt (Zonar)", "unit NPR-1: HTTP 403");
    await alertOps("GPS TrackIt (Zonar)", "unit NPR-2: HTTP 500");
    expect(slackNotify).toHaveBeenCalledTimes(2);
  });

  it("never throws even if Slack rejects", async () => {
    slackNotify.mockRejectedValueOnce(new Error("boom"));
    const { alertOps } = await import("./alert");
    await expect(alertOps("fan-out", "kaboom")).resolves.toBeUndefined();
  });
});
