import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { recordInstaworkProbe } from "./state";

// pull_state lives in the settings table; clear it between cases so each starts clean.
beforeEach(() => {
  getDb().prepare("DELETE FROM settings WHERE key = 'pull_state'").run();
});

const t = (iso: string): Date => new Date(iso);

describe("recordInstaworkProbe", () => {
  it("first-ever observation never alerts (OK or failed)", () => {
    expect(recordInstaworkProbe(true, "3 shifts", t("2026-10-02T10:00:00Z")).alert).toBeNull();
    getDb().prepare("DELETE FROM settings WHERE key = 'pull_state'").run();
    expect(recordInstaworkProbe(false, "HTTP 403", t("2026-10-02T10:00:00Z")).alert).toBeNull();
  });

  it("alerts once when it FLIPS from OK to failed", () => {
    recordInstaworkProbe(true, "3 shifts", t("2026-10-02T10:00:00Z"));
    const flip = recordInstaworkProbe(false, "HTTP 403", t("2026-10-02T10:10:00Z"));
    expect(flip.alert).toMatch(/Instawork connection is down/i);
    expect(flip.alert).toMatch(/HTTP 403/);
  });

  it("dedups: a second failing probe inside the 2h cool-off does not re-alert", () => {
    recordInstaworkProbe(true, "ok", t("2026-10-02T10:00:00Z"));
    expect(recordInstaworkProbe(false, "HTTP 403", t("2026-10-02T10:10:00Z")).alert).toBeTruthy();
    expect(recordInstaworkProbe(false, "HTTP 403", t("2026-10-02T11:00:00Z")).alert).toBeNull(); // 50m later
  });

  it("re-alerts a sustained failure after the 2h cool-off", () => {
    recordInstaworkProbe(true, "ok", t("2026-10-02T10:00:00Z"));
    expect(recordInstaworkProbe(false, "HTTP 403", t("2026-10-02T10:10:00Z")).alert).toBeTruthy();
    expect(recordInstaworkProbe(false, "HTTP 403", t("2026-10-02T12:20:00Z")).alert).toBeTruthy(); // >2h later
  });

  it("alerts recovery only after a failure was alerted", () => {
    recordInstaworkProbe(true, "ok", t("2026-10-02T10:00:00Z"));
    recordInstaworkProbe(false, "HTTP 403", t("2026-10-02T10:10:00Z")); // alerted down
    const rec = recordInstaworkProbe(true, "5 shifts", t("2026-10-02T10:20:00Z"));
    expect(rec.alert).toMatch(/Instawork connection recovered/i);
  });

  it("does not send a recovery alert for a failure that never alerted", () => {
    // failed first (no flip → no alert), then recovers → no recovery alert
    recordInstaworkProbe(false, "HTTP 403", t("2026-10-02T10:00:00Z"));
    expect(recordInstaworkProbe(true, "ok", t("2026-10-02T10:10:00Z")).alert).toBeNull();
  });
});
