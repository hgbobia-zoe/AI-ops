import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Stop, StopState } from "@/lib/types";

// Mock the IO deps so this tests the mint TIMING/GATE logic in isolation (no real DB, geocode, or GPS).
vi.mock("./geo", () => ({ geocode: vi.fn() }));
vi.mock("./liveEta", () => ({ computeLiveEta: vi.fn(async () => null) }));
vi.mock("@/lib/pull/state", () => ({
  etaLinkConfigured: vi.fn(() => true),
  etaLinkPollerReady: vi.fn(() => false),
}));
vi.mock("@/lib/db/repo", () => ({
  enqueueEtaLinkMint: vi.fn(),
  getMintedEtaLinkForStop: vi.fn(),
  getEtaLinkStateForStop: vi.fn(),
}));

import { mintEtaLinkForStop } from "./mint";
import { geocode } from "./geo";
import { etaLinkConfigured, etaLinkPollerReady } from "@/lib/pull/state";
import { enqueueEtaLinkMint, getMintedEtaLinkForStop, getEtaLinkStateForStop } from "@/lib/db/repo";

const IGN = "https://ignition.zonarsystems.com/etaLink/abc123";

function stop(over: Partial<Stop> = {}): Stop {
  return {
    stopId: "S-1",
    routeId: "R-1",
    customerId: "C-1",
    sequence: 1,
    state: "EnRoute" as StopState,
    custName: "Smith - Wedding",
    custPhone: "+13015550123",
    address: "111 Rockville Pike, Rockville, MD 20850",
    kind: "delivery",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ETA_LINK_MINT;
  vi.mocked(etaLinkConfigured).mockReturnValue(true);
  vi.mocked(etaLinkPollerReady).mockReturnValue(false); // the key case: configured but STALE heartbeat
  vi.mocked(geocode).mockResolvedValue({ lat: 39.08, lng: -77.14 });
  vi.mocked(enqueueEtaLinkMint).mockReturnValue({ id: "EL-1", stopId: "S-1", status: "pending" });
  vi.mocked(getMintedEtaLinkForStop).mockReturnValue(null);
  vi.mocked(getEtaLinkStateForStop).mockReturnValue({ id: "EL-1", stopId: "S-1", status: "pending" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mintEtaLinkForStop — departure gate keys off CONFIGURED, not the 20m ready heartbeat", () => {
  it("configured + STALE heartbeat → WAITS and returns the minted URL when it lands (was: immediate /track)", async () => {
    vi.useFakeTimers();
    // poller heartbeat is stale (etaLinkPollerReady=false) but Ignition IS configured here.
    let polls = 0;
    vi.mocked(getMintedEtaLinkForStop).mockImplementation(() => (++polls >= 2 ? { url: IGN, code: "abc123" } : null));

    const p = mintEtaLinkForStop(stop(), "E450", "Ford E450");
    await vi.advanceTimersByTimeAsync(60000); // run the bounded wait loop
    const res = await p;

    expect(res.url).toBe(IGN);
    expect(res.reason).toBe("minted");
    expect(res.pollerReady).toBe(false); // honest: the heartbeat really was stale
    expect(enqueueEtaLinkMint).toHaveBeenCalledTimes(1);
  });

  it("UNCONFIGURED office → returns immediately with no wait (fast path preserved)", async () => {
    vi.mocked(etaLinkConfigured).mockReturnValue(false);
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const res = await mintEtaLinkForStop(stop(), "E450", "Ford E450");

    expect(res).toEqual({ url: null, reason: "unconfigured", pollerReady: false });
    expect(enqueueEtaLinkMint).toHaveBeenCalledTimes(1); // still enqueues (so /track can upgrade later)
    expect(setTimeoutSpy).not.toHaveBeenCalled(); // never slept
  });

  it("an already-minted (reused/pre-minted) row returns instantly", async () => {
    vi.mocked(enqueueEtaLinkMint).mockReturnValue({ id: "EL-1", stopId: "S-1", status: "minted", url: IGN });
    const res = await mintEtaLinkForStop(stop(), "E450", "Ford E450");
    expect(res).toEqual({ url: IGN, reason: "minted", pollerReady: false });
  });

  it("passes maxPendingAgeMs so a stale, never-drained pending row is re-enqueued at the click", async () => {
    vi.mocked(etaLinkConfigured).mockReturnValue(false); // short-circuit the wait for this assertion
    await mintEtaLinkForStop(stop(), "E450", "Ford E450");
    const arg = vi.mocked(enqueueEtaLinkMint).mock.calls[0][0];
    expect(typeof arg.maxPendingAgeMs).toBe("number");
    expect(arg.maxPendingAgeMs).toBeGreaterThan(0);
  });
});

describe("mintEtaLinkForStop — fallback reasons are recorded (never a silent /track)", () => {
  it("times out after the bounded window → reason wait-timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(getMintedEtaLinkForStop).mockReturnValue(null); // never lands

    const p = mintEtaLinkForStop(stop(), "E450", "Ford E450");
    await vi.advanceTimersByTimeAsync(60000);
    const res = await p;

    expect(res).toEqual({ url: null, reason: "wait-timeout", pollerReady: false });
  });

  it("a mint ERROR on the fresh attempt stops the wait early → reason error", async () => {
    vi.useFakeTimers();
    vi.mocked(getEtaLinkStateForStop).mockReturnValue({ id: "EL-1", stopId: "S-1", status: "error", error: "boom" });

    const p = mintEtaLinkForStop(stop(), "E450", "Ford E450");
    await vi.advanceTimersByTimeAsync(60000);
    const res = await p;

    expect(res).toEqual({ url: null, reason: "error", pollerReady: false });
  });

  it("a geocode miss → reason geocode-fail (no mint request possible)", async () => {
    vi.mocked(geocode).mockResolvedValue(null);
    const res = await mintEtaLinkForStop(stop(), "E450", "Ford E450");
    expect(res).toEqual({ url: null, reason: "geocode-fail", pollerReady: false });
    expect(enqueueEtaLinkMint).not.toHaveBeenCalled();
  });

  it("no address → reason no-address", async () => {
    const res = await mintEtaLinkForStop(stop({ address: "" }), "E450", "Ford E450");
    expect(res).toEqual({ url: null, reason: "no-address", pollerReady: false });
  });

  it("ETA_LINK_MINT=0 disables minting → reason disabled", async () => {
    process.env.ETA_LINK_MINT = "0";
    const res = await mintEtaLinkForStop(stop(), "E450", "Ford E450");
    expect(res).toEqual({ url: null, reason: "disabled", pollerReady: false });
  });

  it("carries pollerReady=true through when the heartbeat IS fresh", async () => {
    vi.mocked(etaLinkPollerReady).mockReturnValue(true);
    vi.mocked(enqueueEtaLinkMint).mockReturnValue({ id: "EL-1", stopId: "S-1", status: "minted", url: IGN });
    const res = await mintEtaLinkForStop(stop(), "E450", "Ford E450");
    expect(res.pollerReady).toBe(true);
  });
});
