import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-seo-watch-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
  delete process.env.SLACK_ALERT_WEBHOOK_URL; // keep Slack unconfigured → honest skip, no network
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("seoWatcherStatus", () => {
  it("reports all seeds pending on a fresh DB, then counts a discovery", async () => {
    const { seoWatcherStatus } = await import("./watcher");
    const fresh = seoWatcherStatus();
    expect(fresh.totalSeeds).toBeGreaterThan(0);
    expect(fresh.discovered).toBe(0);
    expect(fresh.pending).toBe(fresh.totalSeeds);
    expect(fresh.lastIngestAt).toBeNull();
    expect(fresh.lastLimitHitAt).toBeNull();

    const { ingestKeywordResults } = await import("./discovery");
    ingestKeywordResults({ keywords: [{ keyword: "tent rental", category: "tents", location: "DMV", intent: "commercial", rawResult: { volume: 1300, difficulty: 28 } }] });
    const after = seoWatcherStatus();
    expect(after.discovered).toBe(1);
    expect(after.pending).toBe(after.totalSeeds - 1);
    expect(after.lastIngestAt).not.toBeNull();
  });

  it("surfaces a limit-hit timestamp after one is recorded", async () => {
    const { ingestKeywordResults } = await import("./discovery");
    const { seoWatcherStatus } = await import("./watcher");
    ingestKeywordResults({ keywords: [], meta: { limitHit: true } });
    expect(seoWatcherStatus().lastLimitHitAt).not.toBeNull();
  });
});

describe("alertLimitHit — deduped", () => {
  it("skips honestly when Slack is unconfigured and does not arm the cooldown", async () => {
    const { alertLimitHit } = await import("./watcher");
    const r = await alertLimitHit({ quota: { resetAt: "2026-01-01T00:00:00Z" } });
    expect(r.alerted).toBe(false);
    expect(r.skipped).toBe("slack"); // not "cooldown" — a failed send must not suppress the next attempt
  });

  it("respects the cooldown once an alert time is recorded", async () => {
    const { alertLimitHit } = await import("./watcher");
    const { setJson } = await import("@/lib/kv");
    setJson("seo.lastLimitAlertMs", Date.now()); // simulate a just-sent alert
    const r = await alertLimitHit();
    expect(r.alerted).toBe(false);
    expect(r.skipped).toBe("cooldown");
  });
});
