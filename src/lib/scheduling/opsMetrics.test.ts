import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeBaseline, type BaselineRaw } from "./opsMetrics";

// ── Pure aggregation (no DB) ───────────────────────────────────────────────────────────────────────
describe("summarizeBaseline (pure)", () => {
  const raw: BaselineRaw = {
    events: [
      { kind: "assigned", shiftDate: "2026-12-10", ts: "2026-12-08T10:00:00Z", actor: "system", assignmentId: "a1" },
      { kind: "assigned", shiftDate: "2026-12-10", ts: "2026-12-08T10:01:00Z", actor: "system", assignmentId: "a2" },
      { kind: "packet_sent", shiftDate: "2026-12-10", ts: "2026-12-09T08:00:00Z", actor: "system", assignmentId: "a1" },
      { kind: "notify", shiftDate: "2026-12-10", ts: "2026-12-09T08:05:00Z", actor: "Lisa", assignmentId: "a2" },
      { kind: "confirmed", shiftDate: "2026-12-10", ts: "2026-12-09T09:00:00Z", actor: "Lisa", assignmentId: "a1" },
      { kind: "override", shiftDate: "2026-12-10", ts: "2026-12-09T11:00:00Z", actor: "Lisa", assignmentId: "a2" },
      { kind: "cancelled", shiftDate: "2026-12-10", ts: "2026-12-09T12:00:00Z", actor: "Lisa", assignmentId: "a2" },
    ],
    exceptions: [
      { code: "understaffed", status: "RESOLVED", firstDetectedAt: "2026-12-09T08:00:00Z", resolvedAt: "2026-12-09T09:00:00Z" }, // 60m
      { code: "understaffed", status: "RESOLVED", firstDetectedAt: "2026-12-09T08:00:00Z", resolvedAt: "2026-12-09T08:20:00Z" }, // 20m
      { code: "not_published", status: "RESOLVED", firstDetectedAt: "2026-12-09T08:00:00Z", resolvedAt: "2026-12-09T08:40:00Z" }, // 40m
      { code: "no_truck", status: "OPEN", firstDetectedAt: "2026-12-10T07:00:00Z", resolvedAt: null },
    ],
    audits: [
      { action: "ROUTE_SYNC_AUTO_ASSIGNED", ts: "2026-12-08T10:00:00Z" },
      { action: "ROUTE_SYNC_AUTO_ASSIGNED", ts: "2026-12-08T10:01:00Z" },
      { action: "ROUTE_SYNC_SHIFT_EXPANDED", ts: "2026-12-09T06:00:00Z" },
      { action: "SHIFT_PUBLISH_SENT", ts: "2026-12-09T07:00:00Z" },
      { action: "SHIFT_PUBLISH_NO_SCHEDULER", ts: "2026-12-09T07:05:00Z" },
      { action: "ROUTE_SYNC_NEEDS_REVIEW", ts: "2026-12-09T07:10:00Z" },
    ],
  };
  const out = summarizeBaseline(raw, { start: "2026-12-08", end: "2026-12-10" });

  it("separates the assigned / notified / confirmed funnel and flags confirmation as not observable", () => {
    expect(out.funnel.assigned).toBe(2);
    expect(out.funnel.notified).toBe(2); // packet_sent + notify
    expect(out.funnel.confirmed).toBe(1);
    expect(out.funnel.confirmedObservable).toBe(false);
  });

  it("counts assignment mutations and engine actions from events + audit", () => {
    expect(out.assignments).toMatchObject({ created: 2, overridden: 1, cancelled: 1, reassigned: 0 });
    expect(out.autoAssigned).toBe(2);
    expect(out.shiftsAdjustedToRoute).toBe(1);
    expect(out.publishes).toEqual({ sent: 1, failedNoScheduler: 1 });
    expect(out.needsReview).toBe(1);
  });

  it("rolls exceptions up with an honest median time-to-resolve (null when nothing resolved)", () => {
    expect(out.exceptions.opened).toBe(4);
    expect(out.exceptions.resolved).toBe(3);
    expect(out.exceptions.stillOpen).toBe(1);
    expect(out.exceptions.byCode).toEqual({ understaffed: 2, not_published: 1, no_truck: 1 });
    expect(out.exceptions.medianMinutesToResolve).toBe(40); // median of 20,40,60
    const none = summarizeBaseline({ events: [], exceptions: [], audits: [] }, { start: "2026-12-08", end: "2026-12-10" });
    expect(none.exceptions.medianMinutesToResolve).toBeNull(); // not fabricated as 0
  });

  it("computes an inclusive day span and always carries honesty caveats", () => {
    expect(out.window.days).toBe(3); // 08,09,10 inclusive
    expect(out.caveats.length).toBeGreaterThan(0);
    expect(out.caveats.join(" ")).toMatch(/not a fake|no time-saved|No time-saved/i);
    expect(out.manualTouchpoints).toBeGreaterThan(0); // Lisa events + override + needs-review
  });
});

// ── Integration (reads the real tables) ──────────────────────────────────────────────────────────────
describe("computeSchedulingBaseline (DB)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "aiops-opsmetrics-"));
    process.env.DATABASE_PATH = join(dir, "test.db");
  });
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("reads events, exceptions and audit rows for the window from the live tables", async () => {
    const D = "2026-12-10";
    const store = await import("./store");
    const { logShiftEvent } = await import("./assignments");
    const { getDb } = await import("@/lib/db");
    const { computeSchedulingBaseline } = await import("./opsMetrics");

    const shift = store.createShift({ date: D, role: "driver", headcount: 1, startTime: `${D}T14:00:00.000Z`, endTime: `${D}T18:00:00.000Z`, windowKnown: true, routeId: "rM", truckId: "E450", assignees: [42], source: "manual" });
    logShiftEvent({ shiftId: shift.id, kind: "assigned", changeKey: `${shift.id}:assigned:42` });
    logShiftEvent({ shiftId: shift.id, kind: "packet_sent", changeKey: `${shift.id}:packet:v1` });
    logShiftEvent({ shiftId: shift.id, kind: "confirmed", actor: "Lisa", changeKey: `${shift.id}:confirmed` });

    const db = getDb();
    db.prepare(
      `INSERT INTO audit_logs (audit_id, actor, action, entity, entity_id, before, after, ts)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("AL-1", "system", "ROUTE_SYNC_SHIFT_EXPANDED", "shift", shift.id, null, "{}", `${D}T06:00:00.000Z`);
    db.prepare(
      `INSERT INTO audit_logs (audit_id, actor, action, entity, entity_id, before, after, ts)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("AL-2", "system", "SHIFT_PUBLISH_SENT", "shift", shift.id, null, "{}", `${D}T07:00:00.000Z`);
    db.prepare(
      `INSERT INTO shift_exceptions (id, signature, shift_id, route_id, date, code, severity, status, title, detail, fix_label, first_detected_at, last_seen_at, resolved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("SX-1", `${shift.id}:understaffed`, shift.id, "rM", D, "understaffed", "RED", "RESOLVED", "t", "d", "f", `${D}T07:00:00.000Z`, `${D}T07:30:00.000Z`, `${D}T07:30:00.000Z`);

    const b = computeSchedulingBaseline(D, D);
    expect(b.funnel).toMatchObject({ assigned: 1, notified: 1, confirmed: 1 });
    expect(b.shiftsAdjustedToRoute).toBe(1);
    expect(b.publishes.sent).toBe(1);
    expect(b.exceptions.opened).toBe(1);
    expect(b.exceptions.resolved).toBe(1);
    expect(b.exceptions.medianMinutesToResolve).toBe(30);
  });
});
