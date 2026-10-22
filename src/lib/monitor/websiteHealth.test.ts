import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { checkWebsiteHealth, recordWebsiteProbe, runWebsiteMonitor, type WebsiteCheck } from "./websiteHealth";

// The monitor state lives in the settings table under "website_monitor"; clear it between cases.
beforeEach(() => {
  getDb().prepare("DELETE FROM settings WHERE key = 'website_monitor'").run();
  getDb().prepare("DELETE FROM settings WHERE key = 'app'").run();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MONITOR_URLS;
});

const t = (iso: string): Date => new Date(iso);
const check = (over: Partial<WebsiteCheck>): WebsiteCheck => ({
  url: "https://zoeeventsdmv.com",
  ok: true,
  status: 200,
  error: null,
  ms: 5,
  ...over,
});

// Mock global fetch to resolve with a given status (optionally flagging a followed redirect).
function mockFetchStatus(status: number, redirected = false): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, redirected })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal("fetch", fn);
  return fn;
}
// Mock global fetch to reject (network error, or an abort to simulate the timeout).
function mockFetchReject(err: Error): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    throw err;
  }) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("checkWebsiteHealth", () => {
  it("a final 200 is healthy", async () => {
    mockFetchStatus(200);
    const r = await checkWebsiteHealth("https://zoeeventsdmv.com");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.error).toBeNull();
  });

  it("a redirect chain that resolves to 200 is healthy", async () => {
    // fetch with redirect:follow surfaces only the FINAL response; a 200 with redirected=true is healthy.
    mockFetchStatus(200, true);
    const r = await checkWebsiteHealth("https://zoeeventsdmv.com");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it("a 500 is unhealthy with an HTTP-status reason", async () => {
    mockFetchStatus(500);
    const r = await checkWebsiteHealth("https://zoeeventsdmv.com");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toBe("HTTP 500");
  });

  it("a 4xx that does not resolve to 200 is unhealthy", async () => {
    mockFetchStatus(403);
    const r = await checkWebsiteHealth("https://zoeeventsdmv.com");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toBe("HTTP 403");
  });

  it("a network error is unhealthy and reported as unreachable (distinct from an HTTP code)", async () => {
    mockFetchReject(new Error("ECONNREFUSED"));
    const r = await checkWebsiteHealth("https://zoeeventsdmv.com");
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.error).toBe("unreachable");
  });

  it("a timeout (abort) is unhealthy and reported as a timeout", async () => {
    mockFetchReject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    const r = await checkWebsiteHealth("https://zoeeventsdmv.com", Date.now(), 10_000);
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.error).toBe("timeout after 10000ms");
  });

  it("never throws, even on an unexpected fetch rejection", async () => {
    mockFetchReject(new Error("boom"));
    await expect(checkWebsiteHealth("https://zoeeventsdmv.com")).resolves.toMatchObject({ ok: false });
  });
});

describe("recordWebsiteProbe (mirrors recordInstaworkProbe)", () => {
  it("a cold-start first observation never alerts (up or down)", () => {
    expect(recordWebsiteProbe(check({ ok: true }), t("2026-10-02T10:00:00Z")).alert).toBeNull();
    getDb().prepare("DELETE FROM settings WHERE key = 'website_monitor'").run();
    expect(recordWebsiteProbe(check({ ok: false, status: 500, error: "HTTP 500" }), t("2026-10-02T10:00:00Z")).alert).toBeNull();
  });

  it("pages ONCE when a sustained failure follows a known-good baseline", () => {
    recordWebsiteProbe(check({ ok: true }), t("2026-10-02T10:00:00Z")); // baseline
    const flip = recordWebsiteProbe(check({ ok: false, status: 500, error: "HTTP 500" }), t("2026-10-02T10:15:00Z"));
    expect(flip.alert).toMatch(/is DOWN/i);
    expect(flip.alert).toMatch(/HTTP 500/);
    expect(flip.alert).toMatch(/zoeeventsdmv\.com/);
    expect(flip.alert).toMatch(/Failing since/i);
  });

  it("dedups: a second failing observation inside the 2h cool-off does not re-alert", () => {
    recordWebsiteProbe(check({ ok: true }), t("2026-10-02T10:00:00Z"));
    expect(recordWebsiteProbe(check({ ok: false, status: 500, error: "HTTP 500" }), t("2026-10-02T10:15:00Z")).alert).toBeTruthy();
    expect(recordWebsiteProbe(check({ ok: false, status: 500, error: "HTTP 500" }), t("2026-10-02T11:00:00Z")).alert).toBeNull();
  });

  it("re-alerts a sustained failure after the 2h cool-off", () => {
    recordWebsiteProbe(check({ ok: true }), t("2026-10-02T10:00:00Z"));
    expect(recordWebsiteProbe(check({ ok: false, status: 500, error: "HTTP 500" }), t("2026-10-02T10:15:00Z")).alert).toBeTruthy();
    expect(recordWebsiteProbe(check({ ok: false, status: 500, error: "HTTP 500" }), t("2026-10-02T12:30:00Z")).alert).toBeTruthy();
  });

  it("reports unreachable (network) distinctly from an HTTP code in the alert", () => {
    recordWebsiteProbe(check({ ok: true }), t("2026-10-02T10:00:00Z"));
    const a = recordWebsiteProbe(check({ ok: false, status: null, error: "unreachable" }), t("2026-10-02T10:15:00Z")).alert!;
    // The failure REASON is the network-level "unreachable", not an HTTP status code like "(HTTP 500)".
    expect(a).toContain("(unreachable)");
    expect(a).not.toMatch(/\(HTTP \d/);
  });

  it("emits one recovery message after a failure was alerted", () => {
    recordWebsiteProbe(check({ ok: true }), t("2026-10-02T10:00:00Z"));
    recordWebsiteProbe(check({ ok: false, status: 500, error: "HTTP 500" }), t("2026-10-02T10:15:00Z")); // alerted down
    const rec = recordWebsiteProbe(check({ ok: true }), t("2026-10-02T10:30:00Z"));
    expect(rec.alert).toMatch(/back up/i);
  });

  it("does not send a recovery message for a failure that never alerted (cold start then recovery)", () => {
    recordWebsiteProbe(check({ ok: false, status: 500, error: "HTTP 500" }), t("2026-10-02T10:00:00Z")); // cold start, no page
    expect(recordWebsiteProbe(check({ ok: true }), t("2026-10-02T10:15:00Z")).alert).toBeNull();
  });

  it("tracks state per-url independently", () => {
    const a = "https://zoeeventsdmv.com";
    const b = "https://zoeeventsdmv.com/contact";
    recordWebsiteProbe(check({ url: a, ok: true }), t("2026-10-02T10:00:00Z"));
    recordWebsiteProbe(check({ url: b, ok: true }), t("2026-10-02T10:00:00Z"));
    // a goes down (sustained) and pages for a only; b stays up and is silent.
    const aDown = recordWebsiteProbe(check({ url: a, ok: false, status: 503, error: "HTTP 503" }), t("2026-10-02T10:15:00Z")).alert;
    expect(aDown).toMatch(/is DOWN/i);
    expect(aDown).toContain(a);
    expect(recordWebsiteProbe(check({ url: b, ok: true }), t("2026-10-02T10:15:00Z")).alert).toBeNull();
  });

  it("alert copy carries no dash or emoji (house comms style)", () => {
    recordWebsiteProbe(check({ ok: true }), t("2026-10-02T10:00:00Z"));
    const a = recordWebsiteProbe(check({ ok: false, status: 500, error: "HTTP 500" }), t("2026-10-02T10:15:00Z")).alert!;
    expect(a).not.toMatch(/[—–]/); // no em/en dashes (ISO timestamps legitimately contain hyphens)
    expect(a).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u); // no emoji
  });
});

describe("runWebsiteMonitor", () => {
  it("checks the configured urls and reports up/down without throwing", async () => {
    process.env.MONITOR_URLS = "https://zoeeventsdmv.com";
    mockFetchStatus(200);
    const r = await runWebsiteMonitor(t("2026-10-02T10:00:00Z"));
    expect(r.checked).toBe(1);
    expect(r.down).toEqual([]);
    expect(r.checks[0].ok).toBe(true);
  });

  it("surfaces a down url in the run summary", async () => {
    process.env.MONITOR_URLS = "https://zoeeventsdmv.com";
    mockFetchStatus(500);
    const r = await runWebsiteMonitor(t("2026-10-02T10:00:00Z"));
    expect(r.down).toEqual(["https://zoeeventsdmv.com"]);
  });
});
