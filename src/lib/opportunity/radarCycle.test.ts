import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notify/alert", () => ({ alertOps: vi.fn(async () => {}) }));

import { isDue, radarCycleConfigured, runRadarCycle } from "./radarCycle";
import { RUNTIME_JOBS } from "@/lib/runtime/jobs";
import { setJson } from "@/lib/kv";

afterEach(() => {
  setJson("radar.cycle.lastRun", {});
  setJson("radar.sam.cursors", {});
  delete process.env.SAM_API_KEY;
  delete process.env.RADAR_ICS_FEEDS;
  vi.unstubAllGlobals();
});

describe("isDue", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  it("is due with no prior run, and after the interval", () => {
    expect(isDue(undefined, 24, now)).toBe(true);
    expect(isDue("2026-11-06T11:00:00Z", 24, now)).toBe(true);
    expect(isDue("2026-11-07T01:00:00Z", 24, now)).toBe(false);
  });
});

describe("runRadarCycle", () => {
  it("is not configured without SAM_API_KEY or RADAR_ICS_FEEDS, and says so", async () => {
    expect(radarCycleConfigured()).toBe(false);
    const r = await runRadarCycle(new Date("2026-11-07T12:00:00Z"));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("SAM_API_KEY not set");
  });

  it("pulls SAM.gov once, then waits for the interval (quota)", async () => {
    process.env.SAM_API_KEY = "k";
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ totalRecords: 0, opportunitiesData: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const t0 = new Date("2026-11-07T12:00:00Z");
    const first = await runRadarCycle(t0);
    expect(first.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3); // MD, DC, VA
    const again = await runRadarCycle(new Date("2026-11-07T18:00:00Z"));
    expect(again.detail).toContain("nothing due");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports a failing SAM.gov pull as ok=false", async () => {
    process.env.SAM_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    const r = await runRadarCycle(new Date("2026-11-07T12:00:00Z"));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("daily limit");
    expect(r.detail).not.toContain("api_key");
  });

  it("is registered as a server runtime job", () => {
    const job = RUNTIME_JOBS.find((j) => j.key === "opportunity-radar");
    expect(job?.bucket).toBe("server");
  });
});
