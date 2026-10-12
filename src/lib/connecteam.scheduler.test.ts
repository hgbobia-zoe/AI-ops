import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultScheduler } from "./connecteam";

// The exact failure that silently dropped shift publishes: Connecteam lags, the scheduler list comes back
// empty, and publish aborts with "no scheduler reachable". With CONNECTEAM_SCHEDULER_ID pinned, the default
// scheduler must be synthesized from the id so publish still proceeds.
beforeEach(() => {
  process.env.CONNECTEAM_API_KEY = "test-key";
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONNECTEAM_API_KEY;
  delete process.env.CONNECTEAM_SCHEDULER_ID;
});

function stubSchedulers(schedulers: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { schedulers } }) })),
  );
}

describe("getDefaultScheduler resilience", () => {
  it("synthesizes the pinned scheduler when the live list is empty (Connecteam blip)", async () => {
    process.env.CONNECTEAM_SCHEDULER_ID = "11594873";
    stubSchedulers([]); // empty — as during a timeout/cold cache
    const s = await getDefaultScheduler();
    expect(s).not.toBeNull();
    expect(s!.schedulerId).toBe(11594873);
    expect(s!.timezone).toBe("America/New_York");
  });

  it("synthesizes the pinned id even when the list has OTHER schedulers", async () => {
    process.env.CONNECTEAM_SCHEDULER_ID = "11594873";
    stubSchedulers([{ schedulerId: 42, name: "Other", timezone: "America/Chicago" }]);
    const s = await getDefaultScheduler();
    expect(s!.schedulerId).toBe(11594873); // the pinned one, not the stray list entry
  });
});
