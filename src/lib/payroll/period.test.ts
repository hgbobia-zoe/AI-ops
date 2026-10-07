import { describe, it, expect } from "vitest";
import { currentPayPeriod, previousPayPeriod, resolvePeriod, periodLabel, addDays, namedPeriod } from "./period";
import { workerCounts } from "./workers";
import type { UnifiedWorker, WorkerType } from "./types";

describe("pay-period math", () => {
  it("currentPayPeriod is the Monday–Sunday week containing the date", () => {
    // 2026-10-07 is a Wednesday → Mon Oct 5 .. Sun Oct 11.
    expect(currentPayPeriod("2026-10-07")).toEqual({ start: "2026-10-05", end: "2026-10-11", label: "Oct 5 – Oct 11" });
    // A Monday is the start of its own week.
    expect(currentPayPeriod("2026-10-05").start).toBe("2026-10-05");
    // A Sunday is the END of its week, not the start of the next.
    expect(currentPayPeriod("2026-10-11")).toEqual({ start: "2026-10-05", end: "2026-10-11", label: "Oct 5 – Oct 11" });
  });

  it("previousPayPeriod is the prior complete week", () => {
    expect(previousPayPeriod("2026-10-07")).toEqual({ start: "2026-09-28", end: "2026-10-04", label: "Sep 28 – Oct 4" });
  });

  it("addDays crosses month boundaries in UTC", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("periodLabel formats both ends", () => {
    expect(periodLabel("2026-10-05", "2026-10-11")).toBe("Oct 5 – Oct 11");
  });

  it("namedPeriod selects current vs previous", () => {
    expect(namedPeriod("2026-10-07", "current").start).toBe("2026-10-05");
    expect(namedPeriod("2026-10-07", "previous").start).toBe("2026-09-28");
  });

  describe("resolvePeriod", () => {
    it("accepts a valid explicit range", () => {
      expect(resolvePeriod("2026-10-07", "2026-10-01", "2026-10-07").label).toBe("Oct 1 – Oct 7");
    });
    it("swaps reversed bounds", () => {
      const p = resolvePeriod("2026-10-07", "2026-10-07", "2026-10-01");
      expect(p.start).toBe("2026-10-01");
      expect(p.end).toBe("2026-10-07");
    });
    it("falls back to the current week on invalid/absurd input", () => {
      expect(resolvePeriod("2026-10-07", "garbage", "2026-10-07").start).toBe("2026-10-05"); // bad format
      expect(resolvePeriod("2026-10-07", "2026-01-01", "2026-12-31").start).toBe("2026-10-05"); // > 92 days
      expect(resolvePeriod("2026-10-07", null, null).start).toBe("2026-10-05"); // missing
    });
  });
});

describe("workerCounts", () => {
  const mk = (workerType: WorkerType, active = true): UnifiedWorker => ({
    key: Math.random().toString(), recordId: null, name: "x", email: null, workerType, typeInferred: false,
    country: null, connecteamUserId: null, instaworkWorker: null, inConnecteam: true, gustoId: null,
    gustoMapped: false, payType: "hourly", payRate: null, currency: "USD", active, persisted: false, periodHours: null,
  });

  it("counts by classification and excludes inactive workers", () => {
    const c = workerCounts([
      mk("EMPLOYEE"), mk("EMPLOYEE"), mk("US_CONTRACTOR"), mk("INTERNATIONAL_CONTRACTOR"),
      mk("INTERNATIONAL_CONTRACTOR", false), // inactive → excluded everywhere
    ]);
    expect(c.total).toBe(4);
    expect(c.employees).toBe(2);
    expect(c.contractors).toBe(2); // US + international
    expect(c.international).toBe(1);
  });
});
