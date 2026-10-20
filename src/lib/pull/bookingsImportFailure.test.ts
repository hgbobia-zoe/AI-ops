import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { recordBookingsImportFailure } from "./state";

// pull_state lives in the settings table; clear it between cases so each starts clean.
beforeEach(() => {
  getDb().prepare("DELETE FROM settings WHERE key = 'pull_state'").run();
});

const t = (iso: string): Date => new Date(iso);

describe("recordBookingsImportFailure (mirrors recordInstaworkProbe)", () => {
  it("first-ever observation never alerts (OK or failed)", () => {
    expect(recordBookingsImportFailure(true, "0 orphans archived", t("2026-10-02T10:00:00Z")).alert).toBeNull();
    getDb().prepare("DELETE FROM settings WHERE key = 'pull_state'").run();
    expect(recordBookingsImportFailure(false, "120 active projects missing from the pull", t("2026-10-02T10:00:00Z")).alert).toBeNull();
  });

  it("pages once when a sustained failure follows a known-good baseline", () => {
    recordBookingsImportFailure(true, "ok", t("2026-10-02T10:00:00Z")); // baseline
    const flip = recordBookingsImportFailure(false, "120 active projects missing from the pull", t("2026-10-02T10:10:00Z"));
    expect(flip.alert).toMatch(/keeps skipping orphan cleanup/i);
    expect(flip.alert).toMatch(/120 active projects missing/);
    expect(flip.alert).toMatch(/arm Force-archive in \/admin/i);
  });

  it("dedups: a second failing observation inside the 2h cool-off does not re-alert", () => {
    recordBookingsImportFailure(true, "ok", t("2026-10-02T10:00:00Z"));
    expect(recordBookingsImportFailure(false, "120 missing", t("2026-10-02T10:10:00Z")).alert).toBeTruthy();
    expect(recordBookingsImportFailure(false, "120 missing", t("2026-10-02T11:00:00Z")).alert).toBeNull(); // 50m later
  });

  it("re-alerts a sustained failure after the 2h cool-off", () => {
    recordBookingsImportFailure(true, "ok", t("2026-10-02T10:00:00Z"));
    expect(recordBookingsImportFailure(false, "120 missing", t("2026-10-02T10:10:00Z")).alert).toBeTruthy();
    expect(recordBookingsImportFailure(false, "120 missing", t("2026-10-02T12:20:00Z")).alert).toBeTruthy(); // >2h later
  });

  it("alerts recovery only after a failure was alerted", () => {
    recordBookingsImportFailure(true, "ok", t("2026-10-02T10:00:00Z"));
    recordBookingsImportFailure(false, "120 missing", t("2026-10-02T10:10:00Z")); // alerted down
    const rec = recordBookingsImportFailure(true, "30 orphans archived", t("2026-10-02T10:20:00Z"));
    expect(rec.alert).toMatch(/bookings pull recovered/i);
  });

  it("does not send a recovery alert for a failure that never alerted", () => {
    // failed first (cold start → no page), then recovers → no recovery alert
    recordBookingsImportFailure(false, "120 missing", t("2026-10-02T10:00:00Z"));
    expect(recordBookingsImportFailure(true, "ok", t("2026-10-02T10:10:00Z")).alert).toBeNull();
  });

  it("alert copy carries no em-dash or emoji (house comms style)", () => {
    recordBookingsImportFailure(true, "ok", t("2026-10-02T10:00:00Z"));
    const a = recordBookingsImportFailure(false, "120 missing", t("2026-10-02T10:10:00Z")).alert!;
    expect(a).not.toMatch(/[—–]/); // no em/en dashes
    // no emoji (surrogate-pair / pictographic range)
    expect(a).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
