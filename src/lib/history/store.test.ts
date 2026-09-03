import { describe, it, expect } from "vitest";
import {
  captureEventSnapshot,
  logChange,
  getEventTimeline,
  getRecentChanges,
  getLatestSnapshotDates,
  recordEventOutcome,
  getRecentOutcomes,
  type SnapshotInput,
} from "./store";

// DATABASE_PATH is ":memory:" in tests.
const base: SnapshotInput = {
  eventId: "TX-1",
  eventDate: "2026-09-20",
  label: "Acme Wedding",
  routeId: "R1",
  daysOut: 7,
  driverName: undefined,
  riskLevel: "HIGH",
  readinessScore: 70,
  openRisks: 2,
  revenue: null,
};

describe("history — snapshots dedup on no meaningful change", () => {
  it("writes the first snapshot, skips an identical re-scan, writes again on change", () => {
    expect(captureEventSnapshot(base)).toBe(true); // first
    expect(captureEventSnapshot(base)).toBe(false); // identical → no new snapshot
    expect(captureEventSnapshot({ ...base, driverName: "Marco" })).toBe(true); // driver assigned → change
    expect(captureEventSnapshot({ ...base, driverName: "Marco", riskLevel: "CRITICAL", openRisks: 3 })).toBe(true); // risk worsened
    const { snapshots } = getEventTimeline("TX-1");
    expect(snapshots).toHaveLength(3);
    expect(snapshots.map((s) => s.riskLevel)).toEqual(["HIGH", "HIGH", "CRITICAL"]);
    expect(snapshots[1].driverName).toBe("Marco");
  });

  it("reconstructs 'what did we know N days out' from the snapshot series", () => {
    captureEventSnapshot({ ...base, eventId: "TX-2", daysOut: 14, riskLevel: "MEDIUM", readinessScore: 90 });
    captureEventSnapshot({ ...base, eventId: "TX-2", daysOut: 3, riskLevel: "CRITICAL", readinessScore: 55 });
    const { snapshots } = getEventTimeline("TX-2");
    expect(snapshots.find((s) => s.daysOut === 14)?.riskLevel).toBe("MEDIUM");
    expect(snapshots.find((s) => s.daysOut === 3)?.riskLevel).toBe("CRITICAL");
  });
});

describe("history — change log is append-only + idempotent", () => {
  it("logs a transition once even if the scan re-runs (same change_key)", () => {
    expect(logChange({ source: "risk", entity: "risk", entityId: "sigA", kind: "risk_detected", changeKey: "created|sigA" })).toBe(true);
    expect(logChange({ source: "risk", entity: "risk", entityId: "sigA", kind: "risk_detected", changeKey: "created|sigA" })).toBe(false);
    expect(getRecentChanges().filter((c) => c.entityId === "sigA")).toHaveLength(1);
  });

  it("a genuine escalation to a new level logs separately", () => {
    logChange({ source: "risk", entity: "risk", entityId: "sigB", kind: "risk_escalated", fromValue: "MEDIUM", toValue: "HIGH", changeKey: "escalated|sigB|HIGH" });
    logChange({ source: "risk", entity: "risk", entityId: "sigB", kind: "risk_escalated", fromValue: "HIGH", toValue: "CRITICAL", changeKey: "escalated|sigB|CRITICAL" });
    expect(getRecentChanges().filter((c) => c.entityId === "sigB")).toHaveLength(2);
  });
});

describe("history — reschedule detection + outcomes (MVP4 P3)", () => {
  it("getLatestSnapshotDates reflects the newest date, and a date change makes a new snapshot", () => {
    captureEventSnapshot({ ...base, eventId: "TX-R", eventDate: "2026-09-10" });
    expect(getLatestSnapshotDates().get("TX-R")).toBe("2026-09-10");
    // Same everything but a new date → reschedule → new snapshot (date is in the signature).
    expect(captureEventSnapshot({ ...base, eventId: "TX-R", eventDate: "2026-09-17" })).toBe(true);
    expect(getLatestSnapshotDates().get("TX-R")).toBe("2026-09-17");
    expect(getEventTimeline("TX-R").snapshots).toHaveLength(2);
  });

  it("records an event outcome and marks all_completed correctly, idempotent per (event,route)", () => {
    recordEventOutcome({ eventId: "TX-O", routeId: "R1", date: "2026-09-05", totalStops: 2, completedStops: 1 });
    recordEventOutcome({ eventId: "TX-O", routeId: "R1", date: "2026-09-05", totalStops: 2, completedStops: 2 }); // refresh
    const outs = getRecentOutcomes().filter((o) => o.eventId === "TX-O");
    expect(outs).toHaveLength(1); // upsert, not duplicate
    expect(outs[0].allCompleted).toBe(true);
    expect(outs[0].completedStops).toBe(2);
  });
});
