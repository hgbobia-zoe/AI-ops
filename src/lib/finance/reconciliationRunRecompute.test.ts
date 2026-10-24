import { describe, it, expect, beforeEach } from "vitest";
import { recomputeReconciliationRuns } from "./reconciliationRunRecompute";
import { saveBookings, saveCostEntries, getReconciliationRuns, getLatestReconciliationRun } from "@/lib/db/repo";
import { getDb } from "@/lib/db";
import type { CostEntryInput } from "./allocation";

// DATABASE_PATH is ":memory:" (vitest.config.ts). The setup clears tables per FILE, not per test, so clear
// the tables this file touches before each test to keep them independent.
beforeEach(() => {
  const db = getDb();
  for (const t of ["reconciliation_runs", "cost_entries", "bookings"]) db.prepare(`DELETE FROM "${t}"`).run();
});

const DAY = "2026-06-01";
const PID = "PRJ-1";
const NOW = new Date(`${DAY}T12:00:00Z`);

function seedBooking(paid = 5000, due = 0): void {
  saveBookings([{ bookingId: PID, eventName: "Garden Gala", eventDate: DAY, statusLabel: "Signed", signed: true, contractTotal: 5000, grandTotal: 5000, amountPaid: paid, amountDue: due }]);
  // Keep the booking fresh relative to NOW so staleness never forces PROVISIONAL in these tests.
  getDb().prepare("UPDATE bookings SET updated_at = ? WHERE booking_id = ?").run(`${DAY}T11:30:00Z`, PID);
}

function laborLeaf(amount: number, status: CostEntryInput["amountStatus"], ref: string): CostEntryInput {
  return { type: "labor", class: "DIRECT", eventId: PID, routeId: "R1", day: DAY, amount, amountStatus: status, source: "connecteam", sourceRef: ref, workerKind: "internal", bucket: "customer", method: "PLANNED", confidence: "MEDIUM" };
}
function manualLeaf(amount: number, ref: string): CostEntryInput {
  return { type: "sub_rental", class: "DIRECT", eventId: PID, routeId: "R1", day: DAY, amount, amountStatus: "ACTUAL", source: "manual", sourceRef: ref, method: "ACTUAL_STOP" };
}

describe("recomputeReconciliationRuns — wiring, idempotency, lifecycle, tie", () => {
  it("writes a first run (snapshot), then writes nothing on an unchanged recompute (idempotent)", () => {
    seedBooking();
    saveCostEntries([laborLeaf(1000, "ESTIMATED", "L1")]);

    const r1 = recomputeReconciliationRuns([DAY], NOW);
    expect(r1.runsWritten).toBe(1);
    const latest = getLatestReconciliationRun(PID)!;
    expect(latest.seq).toBe(1);
    expect(latest.phase).toBe("snapshot");
    expect(latest.status).toBe("ESTIMATED"); // labor is planned-grain → estimated, never fabricated final
    expect(latest.directCost).toBe(1000);
    expect(latest.variance).toBeNull(); // first run has no prior

    // Re-run with no data change → sig-dedup → no new run.
    const r2 = recomputeReconciliationRuns([DAY], NOW);
    expect(r2.runsWritten).toBe(0);
    expect(getReconciliationRuns(PID)).toHaveLength(1);
  });

  it("a late timesheet produces a revision with a late_timesheet line and ties to the ledger", () => {
    seedBooking();
    saveCostEntries([laborLeaf(1000, "ESTIMATED", "L1")]);
    recomputeReconciliationRuns([DAY], NOW);

    // A later timesheet lifts the same leaf (idempotent upsert on source_ref).
    saveCostEntries([laborLeaf(1400, "ESTIMATED", "L1")]);
    const r = recomputeReconciliationRuns([DAY], NOW);
    expect(r.runsWritten).toBe(1);

    const runs = getReconciliationRuns(PID);
    expect(runs).toHaveLength(2);
    const rev = runs[0]; // newest first
    expect(rev.seq).toBe(2);
    expect(rev.phase).toBe("revision");
    const line = rev.variance!.lines.find((l) => l.line === "cost.labor")!;
    expect(line.reason).toBe("late_timesheet");
    expect(line.delta).toBe(400);
    // Tie: the run's recorded direct cost equals the sum of the project's DIRECT ledger leaves.
    expect(rev.directCost).toBe(1400);
    expect(rev.balanced).toBe(true);
  });

  it("a manual cost entry lands as a manual_adjustment revision; direct cost sums the families", () => {
    seedBooking();
    saveCostEntries([laborLeaf(1000, "ESTIMATED", "L1")]);
    recomputeReconciliationRuns([DAY], NOW);

    saveCostEntries([manualLeaf(300, "M1")]);
    const r = recomputeReconciliationRuns([DAY], NOW);
    expect(r.runsWritten).toBe(1);

    const rev = getLatestReconciliationRun(PID)!;
    const line = rev.variance!.lines.find((l) => l.line === "cost.sub_rental")!;
    expect(line.reason).toBe("manual_adjustment");
    expect(line.delta).toBe(300);
    expect(rev.directCost).toBe(1300); // 1000 labor + 300 sub-rental — the families sum to the total
    expect(rev.balanced).toBe(true);
  });

  it("never records final while cost is estimated, even when revenue is fully collected", () => {
    seedBooking(5000, 0); // fully collected
    saveCostEntries([laborLeaf(1000, "ESTIMATED", "L1")]);
    recomputeReconciliationRuns([DAY], NOW);
    expect(getLatestReconciliationRun(PID)!.phase).not.toBe("final");
    expect(getLatestReconciliationRun(PID)!.status).toBe("ESTIMATED");
  });

  it("records final once all cost is actual and revenue is fully collected", () => {
    seedBooking(5000, 0);
    saveCostEntries([laborLeaf(1000, "ACTUAL", "L1")]);
    recomputeReconciliationRuns([DAY], NOW);
    const latest = getLatestReconciliationRun(PID)!;
    expect(latest.status).toBe("RECONCILED");
    expect(latest.phase).toBe("final");
  });

  it("is a no-op when disabled via config", () => {
    const prev = process.env.FINANCE_RECONCILIATION_RUNS;
    process.env.FINANCE_RECONCILIATION_RUNS = "0";
    try {
      seedBooking();
      saveCostEntries([laborLeaf(1000, "ESTIMATED", "L1")]);
      const r = recomputeReconciliationRuns([DAY], NOW);
      expect(r.skipped).toBe("disabled");
      expect(getReconciliationRuns(PID)).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.FINANCE_RECONCILIATION_RUNS;
      else process.env.FINANCE_RECONCILIATION_RUNS = prev;
    }
  });
});
