import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the job runner so the pure scheduler pieces can be tested without touching real jobs.
vi.mock("@/lib/runtime/jobs", () => ({
  runServerJobs: vi.fn(async () => [] as unknown[]),
}));

import { runServerJobs } from "@/lib/runtime/jobs";
import {
  startRuntimeClock,
  tick,
  resolveIntervalMin,
  clockEnabled,
  __resetRuntimeClockForTest,
} from "./inProcessClock";

const mockedRun = vi.mocked(runServerJobs);

beforeEach(() => {
  __resetRuntimeClockForTest();
  mockedRun.mockReset();
  mockedRun.mockResolvedValue([] as never);
  delete process.env.RUNTIME_IN_PROCESS_CLOCK;
  delete process.env.RUNTIME_TICK_INTERVAL_MIN;
  process.env.NEXT_RUNTIME = "nodejs"; // the clock only arms in the Node.js server runtime
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  __resetRuntimeClockForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resolveIntervalMin", () => {
  it("defaults to 15 when unset", () => {
    expect(resolveIntervalMin()).toBe(15);
  });

  it("reads a valid override", () => {
    process.env.RUNTIME_TICK_INTERVAL_MIN = "5";
    expect(resolveIntervalMin()).toBe(5);
  });

  it("clamps to the floor (>= 1) for zero/negative", () => {
    process.env.RUNTIME_TICK_INTERVAL_MIN = "0";
    expect(resolveIntervalMin()).toBe(1);
    process.env.RUNTIME_TICK_INTERVAL_MIN = "-10";
    expect(resolveIntervalMin()).toBe(1);
  });

  it("falls back to the default on garbage", () => {
    process.env.RUNTIME_TICK_INTERVAL_MIN = "abc";
    expect(resolveIntervalMin()).toBe(15);
  });

  it("floors a fractional value", () => {
    process.env.RUNTIME_TICK_INTERVAL_MIN = "7.9";
    expect(resolveIntervalMin()).toBe(7);
  });
});

describe("clockEnabled", () => {
  it("is on by default", () => {
    expect(clockEnabled()).toBe(true);
  });
  it("is off only for exactly 'false'", () => {
    process.env.RUNTIME_IN_PROCESS_CLOCK = "false";
    expect(clockEnabled()).toBe(false);
    process.env.RUNTIME_IN_PROCESS_CLOCK = "true";
    expect(clockEnabled()).toBe(true);
  });
});

describe("tick single-flight", () => {
  it("skips a tick while a previous run is still in flight (never overlaps)", async () => {
    let release!: () => void;
    // One-shot: the first call blocks until released; later calls fall back to the resolved base impl.
    mockedRun.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve([] as never); }),
    );

    const p1 = tick(); // starts the run; running=true, awaiting
    const p2 = tick(); // previous still in flight → skipped, runServerJobs NOT called again
    expect(mockedRun).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([p1, p2]);

    // Once the first run finished, a later tick runs normally.
    await tick();
    expect(mockedRun).toHaveBeenCalledTimes(2);
  });

  it("never throws even when a run rejects, and keeps ticking afterward", async () => {
    mockedRun.mockRejectedValueOnce(new Error("boom"));
    await expect(tick()).resolves.toBeUndefined();
    // Guard released → the next tick still runs.
    mockedRun.mockResolvedValueOnce([] as never);
    await tick();
    expect(mockedRun).toHaveBeenCalledTimes(2);
  });
});

describe("startRuntimeClock arming", () => {
  it("fires a first run ~30s after boot, then on each interval", async () => {
    vi.useFakeTimers();
    process.env.RUNTIME_TICK_INTERVAL_MIN = "15";
    startRuntimeClock();

    expect(mockedRun).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(30_000); // first run
    expect(mockedRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000); // one interval
    expect(mockedRun).toHaveBeenCalledTimes(2);
  });

  it("is idempotent — calling it twice creates only one timer set", async () => {
    vi.useFakeTimers();
    startRuntimeClock();
    startRuntimeClock(); // second call is a no-op
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockedRun).toHaveBeenCalledTimes(1); // not 2
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(mockedRun).toHaveBeenCalledTimes(2); // single interval, not doubled
  });

  it("is a no-op when disabled by flag", async () => {
    vi.useFakeTimers();
    process.env.RUNTIME_IN_PROCESS_CLOCK = "false";
    startRuntimeClock();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("is a no-op outside the Node.js server runtime", async () => {
    vi.useFakeTimers();
    process.env.NEXT_RUNTIME = "edge";
    startRuntimeClock();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("uses the env-overridden interval", async () => {
    vi.useFakeTimers();
    process.env.RUNTIME_TICK_INTERVAL_MIN = "2";
    startRuntimeClock();
    await vi.advanceTimersByTimeAsync(30_000); // first run
    expect(mockedRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000); // 2-min interval
    expect(mockedRun).toHaveBeenCalledTimes(2);
  });
});
