import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway DB so the kv (settings) table exists for recordSchedulingAlarm's dedup row.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-autoassign-alarm-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function mod() {
  return import("./autoAssignAlarm");
}

const COOLOFF = 2 * 60 * 60 * 1000; // 2h, matching the shared default

describe("recordSchedulingAlarm (reuses decideJobAlert: 2h cool-off + one-shot recovered)", () => {
  it("driverlessRoutes: pages on first down, stays quiet in the cool-off, re-pages after it, recovers once", async () => {
    const { recordSchedulingAlarm } = await mod();
    const t0 = Date.parse("2026-10-19T12:00:00.000Z");

    // First time the condition is bad → page.
    expect(recordSchedulingAlarm("driverlessRoutes", true, t0).alert).toBe("down");
    // Still bad, inside the cool-off → stay quiet.
    expect(recordSchedulingAlarm("driverlessRoutes", true, t0 + 60 * 60 * 1000).alert).toBeNull();
    // Still bad, past the cool-off → page again.
    expect(recordSchedulingAlarm("driverlessRoutes", true, t0 + COOLOFF + 1000).alert).toBe("down");
    // Cleared → one recovered note.
    expect(recordSchedulingAlarm("driverlessRoutes", false, t0 + COOLOFF + 2000).alert).toBe("recovered");
    // Still clear → nothing.
    expect(recordSchedulingAlarm("driverlessRoutes", false, t0 + COOLOFF + 3000).alert).toBeNull();
  });

  it("never pages when the condition is healthy from a cold start (no false recovery)", async () => {
    const { recordSchedulingAlarm } = await mod();
    const t0 = Date.parse("2026-10-19T12:00:00.000Z");
    // debriefSilent has never been down → a healthy observation must not emit anything.
    expect(recordSchedulingAlarm("debriefSilent", false, t0).alert).toBeNull();
    expect(recordSchedulingAlarm("debriefSilent", false, t0 + 1000).alert).toBeNull();
  });

  it("keeps each alarm kind independent (separate kv rows)", async () => {
    const { recordSchedulingAlarm } = await mod();
    const t0 = Date.parse("2026-10-19T15:00:00.000Z");
    expect(recordSchedulingAlarm("debriefSilent", true, t0).alert).toBe("down");
    // driverlessRoutes was already recovered above → a fresh down here still pages (its own clock).
    expect(recordSchedulingAlarm("driverlessRoutes", true, t0).alert).toBe("down");
  });
});
