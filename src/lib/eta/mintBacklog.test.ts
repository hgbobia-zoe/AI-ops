import { beforeEach, describe, expect, it } from "vitest";
import { statusText } from "@/lib/notify/status";
import { getDb } from "@/lib/db";
import { enqueueEtaLinkMint, recordEtaLinkResult } from "@/lib/db/repo";
import {
  assessMintBacklog,
  checkMintBacklog,
  decideMintBacklogAlert,
  isOpsAlertHour,
  stuckMintAlertText,
  MINT_BACKLOG_RECOVERED_TEXT,
  MINT_BACKLOG_RECOVERED,
  type MintBacklog,
} from "./mintBacklog";
import { ignitionDotStatus } from "./ignitionStatus";

const NOW = Date.parse("2026-11-03T16:00:00Z"); // 11am ET
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();
const HOUR = 3600 * 1000;

describe("assessMintBacklog (pure)", () => {
  it("counts only requests waiting past the threshold, groups by truck, reports the oldest", () => {
    const b = assessMintBacklog(
      [
        { id: "a", truckLabel: "E450", createdAt: minsAgo(5) }, // fresh, not stuck
        { id: "b", truckLabel: "E450", createdAt: minsAgo(45) },
        { id: "c", truckLabel: "NPR-1", createdAt: minsAgo(130) },
        { id: "d", truckLabel: null, createdAt: "not a date" }, // ignored, never fabricated
      ],
      NOW,
      20,
    );
    expect(b.stuck).toBe(2);
    expect(b.oldestMin).toBe(130);
    expect(b.byTruck).toEqual({ E450: 1, "NPR-1": 1 });
  });

  it("an empty or all-fresh queue is not stuck", () => {
    expect(assessMintBacklog([], NOW, 20)).toEqual({ stuck: 0, oldestMin: null, byTruck: {} });
    expect(assessMintBacklog([{ id: "a", truckLabel: "E450", createdAt: minsAgo(19) }], NOW, 20).stuck).toBe(0);
  });
});

describe("decideMintBacklogAlert (pure)", () => {
  const stuck: MintBacklog = { stuck: 3, oldestMin: 90, byTruck: { E450: 3 } };
  const clear: MintBacklog = { stuck: 0, oldestMin: null, byTruck: {} };
  const base = { signedOutAlertCovers: false, opsHour: true, nowMs: NOW, cooloffMs: 2 * HOUR };

  it("alerts a stuck queue even while the session looks healthy", () => {
    const d = decideMintBacklogAlert({ ...base, backlog: stuck, state: {} });
    expect(d.post).toBe("stuck");
    expect(d.next.alertedAt).toBe(new Date(NOW).toISOString());
  });

  it("dedups within the cool-off, re-alerts after it", () => {
    expect(decideMintBacklogAlert({ ...base, backlog: stuck, state: { alertedAt: new Date(NOW - HOUR).toISOString() } }).post).toBeNull();
    expect(decideMintBacklogAlert({ ...base, backlog: stuck, state: { alertedAt: new Date(NOW - 3 * HOUR).toISOString() } }).post).toBe("stuck");
  });

  it("stays quiet when the signed-out alert already covers it, or at night", () => {
    expect(decideMintBacklogAlert({ ...base, backlog: stuck, state: {}, signedOutAlertCovers: true }).post).toBeNull();
    expect(decideMintBacklogAlert({ ...base, backlog: stuck, state: {}, opsHour: false }).post).toBeNull();
  });

  it("posts one recovery only when the queue really drained after an alert", () => {
    const d = decideMintBacklogAlert({ ...base, backlog: clear, state: { alertedAt: minsAgo(30) } });
    expect(d.post).toBe("recovered");
    expect(d.next).toEqual({});
    expect(decideMintBacklogAlert({ ...base, backlog: clear, state: {} }).post).toBeNull();
  });
});

describe("alert text + ops hours", () => {
  it("names the count, age and trucks, with no dashes or emoji", () => {
    const t = stuckMintAlertText({ stuck: 4, oldestMin: 85, byTruck: { E450: 3, "NPR-1": 1 } });
    expect(t).toContain("4 customer tracking links have been stuck in Ignition");
    expect(t).toContain("1h 25m");
    expect(t).toContain("E450: 3, NPR-1: 1");
    for (const s of [t, MINT_BACKLOG_RECOVERED_TEXT]) {
      expect(s).not.toMatch(/[—–]| - /);
      expect(s).toMatch(/^[\x00-\x7F]+$/);
    }
    expect(stuckMintAlertText({ stuck: 1, oldestMin: 25, byTruck: { E450: 1 } })).toContain("1 customer tracking link has");
  });

  it("ops hours are 6am to 9pm Eastern", () => {
    expect(isOpsAlertHour(new Date("2026-11-03T16:00:00Z"), "America/New_York")).toBe(true); // 11am
    expect(isOpsAlertHour(new Date("2026-11-03T08:00:00Z"), "America/New_York")).toBe(false); // 3am
    expect(isOpsAlertHour(new Date("2026-11-04T02:30:00Z"), "America/New_York")).toBe(false); // 9:30pm
  });
});

describe("Connections dot: a fresh check-in with a stuck queue is not green", () => {
  it("shows attention 'Links stuck'", () => {
    const d = ignitionDotStatus({
      health: { ok: true, configured: true, lastReadyAt: new Date(NOW).toISOString() },
      hasDeliveriesToday: true,
      stuckMints: { count: 2, oldestMin: 50 },
    });
    expect(d.status).toBe("attention");
    expect(d.headline).toBe("Links stuck");
  });

  it("stays green when nothing is stuck", () => {
    const d = ignitionDotStatus({ health: { ok: true, configured: true, lastReadyAt: null }, hasDeliveriesToday: true, stuckMints: { count: 0, oldestMin: null } });
    expect(d.status).toBe("ok");
  });
});

describe("checkMintBacklog (DB)", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM eta_links").run();
    getDb().prepare("DELETE FROM settings WHERE key = 'eta_mint_backlog'").run();
  });

  const enqueue = (stopId: string) =>
    enqueueEtaLinkMint({
      stopId,
      truckId: "T1",
      truckLabel: "E450",
      address: "1 Main St, Rockville, MD",
      lat: 39.08,
      lng: -77.15,
      etaHours: null,
      startISO: new Date(NOW).toISOString(),
      endISO: new Date(NOW + 6 * HOUR).toISOString(),
    });
  const age = (id: string, m: number) => getDb().prepare("UPDATE eta_links SET created_at = ? WHERE id = ?").run(minsAgo(m), id);

  it("alerts once on a stuck queue, then recovers once it drains", () => {
    const a = enqueue("S1");
    const b = enqueue("S2");
    age(a.id, 60);
    age(b.id, 40);
    const now = new Date(NOW);

    const first = checkMintBacklog({ signedOutAlertCovers: false, now });
    expect(first.backlog.stuck).toBe(2);
    expect(statusText(first.alert!)).toContain("2 customer tracking links");

    expect(checkMintBacklog({ signedOutAlertCovers: false, now }).alert).toBeNull(); // deduped

    recordEtaLinkResult(a.id, { code: "abc" });
    recordEtaLinkResult(b.id, { error: "mint_failed" }); // no longer pending → no longer stuck
    expect(checkMintBacklog({ signedOutAlertCovers: false, now }).alert).toEqual(MINT_BACKLOG_RECOVERED);
    expect(checkMintBacklog({ signedOutAlertCovers: false, now }).alert).toBeNull();
  });

  it("ignores pending rows whose window already ended", () => {
    const a = enqueue("S3");
    age(a.id, 60);
    getDb().prepare("UPDATE eta_links SET end_iso = ? WHERE id = ?").run(minsAgo(1), a.id);
    expect(checkMintBacklog({ signedOutAlertCovers: false, now: new Date(NOW) }).backlog.stuck).toBe(0);
  });
});
