import { describe, it, expect } from "vitest";
import {
  responderHealth,
  decideReactiveAlert,
  decideJobAlert,
  formatAge,
  RESPONDER_STALE_MS,
  RESPONDER_REACTIVE_COOLOFF_MS,
  RESPONDER_JOB_COOLOFF_MS,
} from "./responderHealth";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("responderHealth — the staleness verdict", () => {
  it("a fresh heartbeat is alive", () => {
    const h = responderHealth({ connected: true, at: iso(30_000) }, NOW);
    expect(h.state).toBe("alive");
    expect(h.alive).toBe(true);
    expect(h.ageMs).toBe(30_000);
  });

  it("just under the threshold is still alive", () => {
    const h = responderHealth({ connected: true, at: iso(RESPONDER_STALE_MS - 1) }, NOW);
    expect(h.state).toBe("alive");
  });

  it("past the threshold is stale", () => {
    const h = responderHealth({ connected: true, at: iso(RESPONDER_STALE_MS + 1) }, NOW);
    expect(h.state).toBe("stale");
    expect(h.alive).toBe(false);
  });

  it("an explicit disconnect is stale regardless of age", () => {
    const h = responderHealth({ connected: false, at: iso(1_000) }, NOW);
    expect(h.state).toBe("stale");
    expect(h.alive).toBe(false);
  });

  it("no record (or no timestamp) is never", () => {
    expect(responderHealth(null, NOW).state).toBe("never");
    expect(responderHealth({}, NOW).state).toBe("never");
    expect(responderHealth({ connected: true }, NOW).state).toBe("never");
    expect(responderHealth({ connected: true, at: "not-a-date" }, NOW).state).toBe("never");
  });

  it("honors a custom threshold", () => {
    expect(responderHealth({ connected: true, at: iso(5_000) }, NOW, 1_000).state).toBe("stale");
    expect(responderHealth({ connected: true, at: iso(500) }, NOW, 1_000).state).toBe("alive");
  });
});

describe("formatAge", () => {
  it("renders seconds, minutes, hours and never", () => {
    expect(formatAge(null)).toBe("never");
    expect(formatAge(45_000)).toBe("45s");
    expect(formatAge(4 * 60_000)).toBe("4m");
    expect(formatAge(3 * 60 * 60_000)).toBe("3h");
  });
});

describe("decideReactiveAlert — short cool-off dedupe", () => {
  it("alerts the first time", () => {
    const { alert, next } = decideReactiveAlert(undefined, NOW);
    expect(alert).toBe(true);
    expect(next.lastAlertedAt).toBe(new Date(NOW).toISOString());
  });

  it("stays quiet inside the cool-off", () => {
    const prev = { lastAlertedAt: iso(RESPONDER_REACTIVE_COOLOFF_MS - 1_000) };
    const { alert, next } = decideReactiveAlert(prev, NOW);
    expect(alert).toBe(false);
    expect(next.lastAlertedAt).toBe(prev.lastAlertedAt); // clock preserved
  });

  it("re-alerts once the cool-off elapses", () => {
    const prev = { lastAlertedAt: iso(RESPONDER_REACTIVE_COOLOFF_MS + 1_000) };
    expect(decideReactiveAlert(prev, NOW).alert).toBe(true);
  });
});

describe("decideJobAlert — 2h cool-off + recovered note", () => {
  it("alerts 'down' the first time it is down", () => {
    const { alert, next } = decideJobAlert(undefined, true, NOW);
    expect(alert).toBe("down");
    expect(next?.lastAlertedAt).toBe(new Date(NOW).toISOString());
    expect(next?.firstDownAt).toBe(new Date(NOW).toISOString());
  });

  it("stays quiet while still down inside the cool-off (keeps the clock)", () => {
    const prev = { firstDownAt: iso(RESPONDER_JOB_COOLOFF_MS), lastAlertedAt: iso(RESPONDER_JOB_COOLOFF_MS - 1_000) };
    const { alert, next } = decideJobAlert(prev, true, NOW);
    expect(alert).toBeNull();
    expect(next?.lastAlertedAt).toBe(prev.lastAlertedAt);
    expect(next?.firstDownAt).toBe(prev.firstDownAt);
  });

  it("re-alerts 'down' once the cool-off elapses", () => {
    const prev = { firstDownAt: iso(RESPONDER_JOB_COOLOFF_MS * 2), lastAlertedAt: iso(RESPONDER_JOB_COOLOFF_MS + 1_000) };
    expect(decideJobAlert(prev, true, NOW).alert).toBe("down");
  });

  it("emits 'recovered' exactly once when it comes back, then forgets", () => {
    const prev = { firstDownAt: iso(RESPONDER_JOB_COOLOFF_MS), lastAlertedAt: iso(60_000) };
    const { alert, next } = decideJobAlert(prev, false, NOW);
    expect(alert).toBe("recovered");
    expect(next).toBeUndefined();
  });

  it("no recovered note if we never alerted", () => {
    const { alert, next } = decideJobAlert(undefined, false, NOW);
    expect(alert).toBeNull();
    expect(next).toBeUndefined();
  });
});
