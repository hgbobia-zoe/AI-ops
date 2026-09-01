import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Route } from "@/lib/types";

// Isolate a throwaway DB file so the migration + column are exercised end-to-end.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-db-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("custFirstName round-trips through the DB", () => {
  it("persists and reads back the customer first name", async () => {
    const { writeRoute, getRoute } = await import("./repo");
    const route: Route = {
      routeId: "R-2026-09-01-TEST",
      truckId: "TEST",
      date: "2026-09-01",
      status: "ready",
      stops: [
        {
          stopId: "R-2026-09-01-TEST-S1",
          routeId: "R-2026-09-01-TEST",
          customerId: "c1",
          sequence: 1,
          state: "Waiting",
          custName: "Lebensohn - Wedding",
          custFirstName: "Dave",
          custPhone: "+13015551234",
          address: "5410 Moorland Lane, Bethesda, MD",
        },
      ],
    };
    writeRoute(route);
    const back = getRoute("TEST");
    expect(back?.stops[0].custFirstName).toBe("Dave");
    expect(back?.stops[0].custName).toBe("Lebensohn - Wedding");
  });
});
