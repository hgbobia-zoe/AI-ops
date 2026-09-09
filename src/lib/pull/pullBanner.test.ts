import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { pullBannerState, recordAgentHeartbeat, recordPull } from "./state";

// pull_state lives in the settings table; clear it between cases so each starts clean.
beforeEach(() => {
  getDb().prepare("DELETE FROM settings WHERE key = 'pull_state'").run();
});

describe("pullBannerState", () => {
  it("no data at all → warns that the pull isn't reporting in", () => {
    const b = pullBannerState(Date.now());
    expect(b?.level).toBe("warn");
    expect(b?.title).toMatch(/auto-pull isn't reporting/i);
  });

  it("a live 'ok' heartbeat → no banner", () => {
    recordAgentHeartbeat("extension", "ok", "5 stops · 12 bookings");
    expect(pullBannerState(Date.now())).toBeNull();
  });

  it("a live 'not_logged_in' heartbeat → red signed-out banner", () => {
    recordAgentHeartbeat("extension", "not_logged_in", null);
    const b = pullBannerState(Date.now());
    expect(b?.level).toBe("error");
    expect(b?.title).toMatch(/signed out/i);
  });

  it("a live 'no_tab' heartbeat → amber open-a-tab banner", () => {
    recordAgentHeartbeat("extension", "no_tab", null);
    const b = pullBannerState(Date.now());
    expect(b?.level).toBe("warn");
    expect(b?.title).toMatch(/no goodshuffle tab/i);
  });

  it("a stale heartbeat is ignored; a recent route pull keeps it quiet", () => {
    const now = Date.now();
    recordAgentHeartbeat("extension", "ok", null, new Date(now - 90 * 60_000)); // 90m ago → not live
    recordPull("route:E450", 5, new Date(now - 60 * 60_000)); // 1h ago → within routeStaleH
    expect(pullBannerState(now)).toBeNull();
  });

  it("no live heartbeat + old routes → warns with the age", () => {
    const now = Date.now();
    recordPull("route:E450", 5, new Date(now - 30 * 3_600_000)); // 30h ago
    const b = pullBannerState(now);
    expect(b?.level).toBe("warn");
    expect(b?.detail).toMatch(/30h ago/);
  });
});
