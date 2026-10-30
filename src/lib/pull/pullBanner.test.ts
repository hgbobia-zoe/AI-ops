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
    recordAgentHeartbeat("extension", "ok", null, null, new Date(now - 90 * 60_000)); // 90m ago → not live
    recordPull("route:E450", 5, new Date(now - 60 * 60_000)); // 1h ago → within routeStaleH
    expect(pullBannerState(now)).toBeNull();
  });

  it("a live 'error' heartbeat is superseded by a fresh route pull → no banner", () => {
    const now = Date.now();
    recordAgentHeartbeat("extension", "error", "no result", null, new Date(now - 2 * 60_000)); // 2m ago, live
    recordPull("route:E450", 5, new Date(now - 1 * 60_000)); // 1m ago → data IS current
    expect(pullBannerState(now)).toBeNull();
  });

  it("a live 'error' heartbeat with stale routes → warns", () => {
    const now = Date.now();
    recordAgentHeartbeat("extension", "error", "no result", null, new Date(now - 2 * 60_000)); // live
    recordPull("route:E450", 5, new Date(now - 3 * 3_600_000)); // 3h ago → still stale
    const b = pullBannerState(now);
    expect(b?.level).toBe("warn");
    expect(b?.title).toMatch(/hit a problem/i);
  });

  it("no live heartbeat + old routes → warns with the age", () => {
    const now = Date.now();
    recordPull("route:E450", 5, new Date(now - 30 * 3_600_000)); // 30h ago
    const b = pullBannerState(now);
    expect(b?.level).toBe("warn");
    expect(b?.detail).toMatch(/30h ago/);
  });

  // ── Redundancy: a healthy puller covers a signed-out peer (the whole point of multiple installs) ──
  it("one install signed out but another is OK → no banner (redundancy holds)", () => {
    const now = Date.now();
    recordAgentHeartbeat("laptop-A", "not_logged_in", null, "Jane laptop", new Date(now - 1 * 60_000));
    recordAgentHeartbeat("office-PC", "ok", "5 stops · 12 bookings", "Office PC", new Date(now - 1 * 60_000));
    expect(pullBannerState(now)).toBeNull();
  });

  it("a signed-out peer, but a recent pull landed from someone → no banner", () => {
    const now = Date.now();
    recordAgentHeartbeat("laptop-A", "not_logged_in", null, null, new Date(now - 1 * 60_000));
    recordPull("route:E450", 5, new Date(now - 5 * 60_000)); // 5m ago → data is fresh
    expect(pullBannerState(now)).toBeNull();
  });

  it("every reporting install signed out AND data stale → red banner (a real, uncovered outage)", () => {
    const now = Date.now();
    recordAgentHeartbeat("laptop-A", "not_logged_in", null, null, new Date(now - 1 * 60_000));
    recordAgentHeartbeat("office-PC", "not_logged_in", null, null, new Date(now - 1 * 60_000));
    const b = pullBannerState(now);
    expect(b?.level).toBe("error");
    expect(b?.title).toMatch(/signed out/i);
    expect(b?.detail).toMatch(/2 pullers/);
  });
});

describe("recordAgentHeartbeat — fleet-down alerting", () => {
  it("one signed-out install while another pulls OK → never alerts", () => {
    const now = Date.now();
    recordAgentHeartbeat("office-PC", "ok", "ok", null, new Date(now - 1 * 60_000));
    const { alert } = recordAgentHeartbeat("laptop-A", "not_logged_in", null, null, new Date(now));
    expect(alert).toBeNull();
  });

  it("alerts only after the WHOLE fleet is down past the sustain window, then recovers once", () => {
    const t0 = Date.now();
    // Fleet goes fully down now; first observation must not page (no blip paging).
    expect(recordAgentHeartbeat("office-PC", "not_logged_in", null, null, new Date(t0)).alert).toBeNull();
    // Still down 20 min later (> 15m sustain) → one page.
    const down = recordAgentHeartbeat("office-PC", "not_logged_in", null, null, new Date(t0 + 20 * 60_000));
    expect(down.alert).toMatch(/down/i);
    expect(down.alert).toMatch(/signed out/i);
    // A puller recovers → exactly one recovery message, bookkeeping cleared.
    const rec = recordAgentHeartbeat("office-PC", "ok", "5 stops", null, new Date(t0 + 25 * 60_000));
    expect(rec.alert).toMatch(/recovered/i);
  });
});
