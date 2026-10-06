import { describe, it, expect } from "vitest";
import { ignitionDotStatus, shouldAlertIgnitionStale } from "./ignitionStatus";

describe("ignitionDotStatus — the Connections dot", () => {
  it("fresh poller → OK (green), never gated by deliveries", () => {
    const d = ignitionDotStatus({ health: { ok: true, configured: true, lastReadyAt: "2026-10-05T14:00:00Z" }, hasDeliveriesToday: false });
    expect(d.status).toBe("ok");
    expect(d.headline).toBe("Live");
  });

  it("stale AND deliveries today AND in use → ATTENTION 'needs sign-in'", () => {
    const d = ignitionDotStatus({ health: { ok: false, configured: true, lastReadyAt: "2026-10-05T09:00:00Z" }, hasDeliveriesToday: true });
    expect(d.status).toBe("attention");
    expect(d.headline).toBe("Needs sign-in");
    expect(d.detail).toContain("ignition.zonarsystems.com");
  });

  it("stale but NO deliveries today, yet configured → IDLE (grey, nothing to track) — not an alarm", () => {
    const d = ignitionDotStatus({ health: { ok: false, configured: true, lastReadyAt: null }, hasDeliveriesToday: false });
    expect(d.status).toBe("idle");
    expect(d.headline).toBe("Idle");
  });

  it("never used here → OFF 'not set up', even with deliveries", () => {
    const d = ignitionDotStatus({ health: { ok: false, configured: false, lastReadyAt: null }, hasDeliveriesToday: true });
    expect(d.status).toBe("off");
    expect(d.headline).toBe("Not set up");
  });
});

describe("shouldAlertIgnitionStale — alert ONLY when it matters", () => {
  const base = { pollerFresh: false, hasDeliveriesToday: true, configured: true, alertedAgoMs: Infinity, cooloffMs: 2 * 60 * 60 * 1000 };

  it("fires when stale + deliveries + configured + past cool-off", () => {
    expect(shouldAlertIgnitionStale(base)).toBe(true);
  });

  it("does NOT fire when the poller is fresh (nothing wrong)", () => {
    expect(shouldAlertIgnitionStale({ ...base, pollerFresh: true })).toBe(false);
  });

  it("does NOT fire when there are no deliveries to track (nothing to mint)", () => {
    expect(shouldAlertIgnitionStale({ ...base, hasDeliveriesToday: false })).toBe(false);
  });

  it("does NOT fire when Ignition was never used here (not configured)", () => {
    expect(shouldAlertIgnitionStale({ ...base, configured: false })).toBe(false);
  });

  it("is deduped by the cool-off (recent alert → suppressed)", () => {
    expect(shouldAlertIgnitionStale({ ...base, alertedAgoMs: 60 * 60 * 1000 })).toBe(false); // 1h < 2h
    expect(shouldAlertIgnitionStale({ ...base, alertedAgoMs: 3 * 60 * 60 * 1000 })).toBe(true); // 3h > 2h
  });
});
