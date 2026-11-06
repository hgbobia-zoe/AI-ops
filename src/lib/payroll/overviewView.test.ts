// Payroll Overview view model, driven by the SAME pure readiness model Payroll Review uses. Fixtures cover a
// ready run, the screenshot's mapping + timesheet issues, overlapping issues, stale data, a partial estimate,
// and a failed Gusto draft update. Overview never offers a submit: every action is a link to a workflow.

import { describe, it, expect } from "vitest";
import { composeReadinessModel } from "./readinessModel";
import { buildOverviewView, type OverviewLedgers } from "./overviewView";
import { runReadiness } from "./runReadiness";
import { draftAttemptLine, submitAttemptLine } from "./attemptText";
import type { TimesheetLockRecord } from "./store";
import type { ReviewWorker, ReadinessWorker, ReadinessException, PayrollReviewResult, PayrollReadiness, PayPeriod, IssueTag, PayrollReadinessModel } from "./types";

const PERIOD: PayPeriod = { start: "2026-10-26", end: "2026-11-01", label: "Oct 26 – Nov 1" };

function rv(o: Partial<ReviewWorker> & { key: string; name: string }): ReviewWorker {
  return {
    key: o.key, name: o.name, workerType: o.workerType ?? "EMPLOYEE", hours: o.hours ?? 10, payRate: o.payRate ?? 20, currency: "USD",
    estPay: o.estPay ?? (o.hours ?? 10) * (o.payRate ?? 20), mappingStatus: o.mappingStatus ?? "CONFIRMED", status: o.status ?? "READY",
    issues: o.issues ?? [], recordId: null, connecteamUserId: o.connecteamUserId ?? 1, rateSource: "gusto", gustoRate: null, gustoRateUnit: null,
    connecteamRate: null, gustoId: o.gustoId ?? "g1", country: null, payType: "hourly",
  };
}
function exc(type: ReadinessException["type"], kind: ReadinessException["kind"]): ReadinessException {
  return { detectKey: `k:${type}`, workerKey: null, workerLabel: null, connecteamUserId: null, type, kind, severity: "MEDIUM", description: "d", ownerAction: "a", source: "connecteam" };
}
function rdw(o: Partial<ReadinessWorker> & { key: string; name: string }): ReadinessWorker {
  return {
    key: o.key, name: o.name, connecteamUserId: 1, actualHours: o.actualHours ?? 10, approvedHours: o.approvedHours ?? 10,
    unapprovedHours: o.unapprovedHours ?? 0, plannedHours: null, issues: o.issues ?? [], status: o.status ?? "READY",
  };
}
function lockFor(workerKey: string): TimesheetLockRecord {
  return { workerKey, connecteamUserId: 1, approvedBy: "Approver", approvedAt: "2026-11-05T15:00:00.000Z", lockStatus: "LOCKED", lockDetail: null, lockedDates: ["2026-10-27"], updatedAt: "2026-11-05T15:00:00.000Z" };
}
function model(o: { workers: ReviewWorker[]; readiness: ReadinessWorker[]; connecteamOk?: boolean; gustoStale?: boolean; approved?: boolean; locked?: string[] }): PayrollReadinessModel {
  const connecteamOk = o.connecteamOk ?? true;
  const review: PayrollReviewResult = {
    period: PERIOD, workers: o.workers, ready: [], review: [], blocked: [], excluded: [], excludedCount: 0,
    counts: { workers: o.workers.length, ready: 0, review: 0, blocked: 0 },
    hours: connecteamOk ? o.workers.reduce((s, w) => s + (w.hours ?? 0), 0) : null,
    blockingIssues: 0, exceptions: 0, missingConfig: 0, estReadyPayroll: null, estReviewPayroll: null, estBlockedPayroll: null,
    status: connecteamOk ? "READY" : "NO_DATA", connecteamOk,
  };
  const readiness: PayrollReadiness = {
    period: PERIOD, status: "READY", connecteamOk, approvalKnown: true, gusto: { configured: true, fresh: !o.gustoStale }, workers: o.readiness,
    exceptions: o.gustoStale ? [exc("GUSTO_STALE", "UNVERIFIED")] : [], counts: { workers: o.readiness.length, ready: 0, actionRequired: 0, blocked: 0 },
    blocking: 0, anomalies: 0, unverified: 0, hours: review.hours, approvedHours: 40, summary: "",
  };
  return composeReadinessModel({
    period: PERIOD, review, readiness, rate: { proposals: 0, salaried: 0, noGustoRate: 0, asOf: null },
    approval: o.approved ? { status: "APPROVED", approvedBy: "Approver", approvedAt: "2026-11-05T15:00:00.000Z" } : null,
    pushedOk: false, pushed: 0, snapshotAt: "2026-11-05T12:00:00.000Z", activity: [],
    sources: { connecteam: true, gusto: true, gustoSnapshotAt: "2026-11-05T11:00:00.000Z", gustoFresh: !o.gustoStale, instaworkOk: true, instaworkAsOf: "2026-11-01T00:00:00.000Z" },
    schedule: { deadlineLabel: "Tuesdays 9:00 AM ET", precheckLabel: null, autoSyncLabel: null },
    timesheetLocks: new Map((o.locked ?? []).map((k) => [k, lockFor(k)])),
  });
}

const NO_MAP: IssueTag = { kind: "BLOCKING", code: "NO_GUSTO_MAPPING", label: "No Gusto mapping" };
const UNAPPROVED = exc("UNAPPROVED_TIMESHEET", "BLOCKING");
const NONE: OverviewLedgers = { lastSync: null, lastPush: null, lastSubmit: null };

// The screenshot's shape: 8 approved in Zoe (days locked), 2 not linked to Gusto, one of those also with
// unapproved Connecteam time.
function screenshotModel(): PayrollReadinessModel {
  const names = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"];
  const ok = names.map((n, i) => rv({ key: `ct:${i}`, name: n }));
  const blocked = [
    rv({ key: "ct:a", name: "Worker X", mappingStatus: "UNMATCHED", gustoId: null, issues: [NO_MAP] }),
    rv({ key: "ct:r", name: "Worker Y", mappingStatus: "UNMATCHED", gustoId: null, issues: [NO_MAP] }),
  ];
  const readiness = [
    ...names.map((n, i) => rdw({ key: `ct:${i}`, name: n, unapprovedHours: 10, approvedHours: 0, issues: [UNAPPROVED] })),
    rdw({ key: "ct:a", name: "Worker X", unapprovedHours: 23.53, approvedHours: 0, issues: [UNAPPROVED] }),
    rdw({ key: "ct:r", name: "Worker Y" }),
  ];
  return model({ workers: [...ok, ...blocked], readiness, approved: true, locked: names.map((_, i) => `ct:${i}`) });
}

describe("buildOverviewView", () => {
  it("ready run → Ready and 'Open payroll review', no issues", () => {
    const m = model({ workers: [rv({ key: "ct:1", name: "A" }), rv({ key: "ct:2", name: "B" })], readiness: [rdw({ key: "ct:1", name: "A" }), rdw({ key: "ct:2", name: "B" })] });
    const v = buildOverviewView(m, NONE);
    expect(v.run.label).toBe("Ready");
    expect(v.action).toMatchObject({ kind: "link", label: "Open payroll review", href: "/payroll?tab=review" });
    expect(v.issues).toHaveLength(0);
    expect(v.affectedWorkers).toBe(0);
  });

  it("screenshot case: mapping comes before the unapproved timesheet → 'Resolve 2 Gusto mappings'", () => {
    const v = buildOverviewView(screenshotModel(), NONE, "&weeksAgo=2");
    expect(v.run.label).toBe("Blocked");
    expect(v.action.kind).toBe("link");
    if (v.action.kind === "link") {
      expect(v.action.label).toBe("Resolve 2 Gusto mappings");
      expect(v.action.href).toContain("weeksAgo=2"); // carries the selected period
    }
    expect(v.issues[0].severity).toBe("blocker"); // blockers listed first
  });

  it("scoped approval facts: 8 approved in Zoe, signed off by Approver, Connecteam approval and lock kept apart", () => {
    const v = buildOverviewView(screenshotModel(), NONE);
    expect(v.approval.zoeApproved).toBe(8);
    expect(v.approval.signOff?.by).toBe("Approver");
    expect(v.approval.ctLocked).toBe(8);
    expect(v.approval.ctUnapproved).toBe(9); // Connecteam's own column, independent of the Zoe approval
    expect(v.run.label).not.toBe("Ready"); // a done worker-level step never reads as a ready run
  });

  it("overlapping issues: one worker with two issues counts once", () => {
    const m = model({
      workers: [rv({ key: "ct:a", name: "A", mappingStatus: "UNMATCHED", gustoId: null, issues: [NO_MAP] }), rv({ key: "ct:b", name: "B" })],
      readiness: [rdw({ key: "ct:a", name: "A", unapprovedHours: 5, issues: [UNAPPROVED] }), rdw({ key: "ct:b", name: "B", unapprovedHours: 2, issues: [UNAPPROVED] })],
    });
    const v = buildOverviewView(m, NONE);
    const total = v.issues.filter((i) => i.severity !== "setup").reduce((s, i) => s + i.count, 0);
    expect(total).toBeGreaterThan(v.affectedWorkers); // the per-issue counts overlap…
    expect(v.affectedWorkers).toBe(2); // …the headline count doesn't
  });

  it("stale Gusto data opens the sources section and holds the run for review", () => {
    const m = model({ workers: [rv({ key: "ct:1", name: "A" })], readiness: [rdw({ key: "ct:1", name: "A" })], gustoStale: true });
    const v = buildOverviewView(m, NONE);
    expect(v.showSources).toBe(true);
    expect(v.run.label).not.toBe("Blocked");
  });

  it("partial gross estimate reports its real coverage", () => {
    const m = model({ workers: [rv({ key: "ct:1", name: "A" }), rv({ key: "ct:2", name: "B" }), rv({ key: "ct:3", name: "C" })], readiness: [rdw({ key: "ct:1", name: "A" }), rdw({ key: "ct:2", name: "B" }), rdw({ key: "ct:3", name: "C" })] });
    m.workers[2].estPay = null; // rate unknown for C
    const v = buildOverviewView(m, NONE);
    expect(v.summary.estCoverage).toEqual({ known: 2, total: 3 });
  });

  it("failed Gusto draft update reads as failed, never as a green 'pushed'", () => {
    const ledgers: OverviewLedgers = { ...NONE, lastPush: { at: "2026-11-06T16:00:00.000Z", ok: false, aborted: null, pushed: 0, failed: 5, skipped: 3, periodStart: PERIOD.start, periodEnd: PERIOD.end } };
    const v = buildOverviewView(screenshotModel(), ledgers);
    expect(v.attempt).toMatchObject({ kind: "draft", tone: "critical", title: "Gusto draft update failed", detail: "0 pushed, 5 failed" });
  });

  it("ignores a draft update from another period", () => {
    const ledgers: OverviewLedgers = { ...NONE, lastPush: { at: "2026-11-06T16:00:00.000Z", ok: true, aborted: null, pushed: 5, failed: 0, skipped: 0, periodStart: "2026-11-02", periodEnd: "2026-11-08" } };
    expect(buildOverviewView(screenshotModel(), ledgers).attempt).toBeNull();
  });

  it("explains a sync that finished with workers to review (not a failed sync)", () => {
    const ledgers: OverviewLedgers = { ...NONE, lastSync: { status: "REQUIRES_REVIEW", at: "2026-11-05T12:00:00.000Z", periodStart: PERIOD.start, periodEnd: PERIOD.end, reviewCount: 2 } };
    const v = buildOverviewView(screenshotModel(), ledgers);
    expect(v.sync.text).toBe("Synced, with workers to review");
    expect(v.sync.explain).toContain("not a failed sync");
    expect(v.sync.forThisPeriod).toBe(true);
  });

  it("Connecteam unreachable → the one action is the hours sync", () => {
    const m = model({ workers: [rv({ key: "ct:1", name: "A" })], readiness: [rdw({ key: "ct:1", name: "A" })], connecteamOk: false });
    expect(buildOverviewView(m, NONE).action.kind).toBe("sync");
  });

  it("agrees with Payroll Review and never offers a submit", () => {
    for (const m of [screenshotModel(), model({ workers: [rv({ key: "ct:1", name: "A" })], readiness: [rdw({ key: "ct:1", name: "A" })] })]) {
      const v = buildOverviewView(m, NONE);
      expect(v.run).toEqual(runReadiness(m)); // the exact result Payroll Review renders
      if (v.action.kind === "link") {
        expect(v.action.href.startsWith("/payroll?tab=")).toBe(true);
        expect(v.action.label.toLowerCase()).not.toContain("submit");
      }
    }
  });
});

describe("attempt wording", () => {
  it("draft: partial and stopped are distinct from success", () => {
    expect(draftAttemptLine({ pushed: 3, failed: 2 })).toMatchObject({ tone: "attention", title: "Gusto draft partly updated" });
    expect(draftAttemptLine({ aborted: "could_not_reach_inputs@/x/inputs" })).toMatchObject({ tone: "critical", title: "Gusto draft update stopped", detail: "couldn't reach the hours page" });
    expect(draftAttemptLine({ ok: true, pushed: 5 })).toMatchObject({ tone: "positive", title: "Gusto draft updated" });
  });
  it("submit: submitted vs stopped", () => {
    expect(submitAttemptLine({ submitted: true })).toMatchObject({ kind: "submit", tone: "positive" });
    expect(submitAttemptLine({ aborted: "not_logged_in" })).toMatchObject({ tone: "critical", detail: "Gusto was signed out" });
  });
});
