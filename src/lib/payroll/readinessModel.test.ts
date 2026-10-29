// Unified payroll readiness model — the reconciliation the whole blade reads from. These tests drive the
// PURE composeReadinessModel (no DB/IO) so every surface's agreement + each state is deterministic.

import { describe, it, expect } from "vitest";
import { composeReadinessModel, payrollApprovability, type ComposeInputs } from "./readinessModel";
import type {
  ReviewWorker, ReadinessWorker, ReadinessException, PayrollReviewResult, PayrollReadiness, PayPeriod,
  IssueTag, PayrollReadinessModel,
} from "./types";

const PERIOD: PayPeriod = { start: "2026-10-19", end: "2026-10-25", label: "Oct 19 – Oct 25" };

function rv(o: Partial<ReviewWorker> & { key: string; name: string }): ReviewWorker {
  return {
    key: o.key, name: o.name, workerType: o.workerType ?? "EMPLOYEE",
    hours: o.hours ?? 10, payRate: o.payRate ?? 20, currency: o.currency ?? "USD",
    estPay: o.estPay ?? (o.hours ?? 10) * (o.payRate ?? 20),
    mappingStatus: o.mappingStatus ?? "CONFIRMED", status: o.status ?? "READY", issues: o.issues ?? [],
    recordId: o.recordId ?? null, connecteamUserId: o.connecteamUserId ?? 1,
    rateSource: o.rateSource ?? "gusto", gustoRate: o.gustoRate ?? null, gustoRateUnit: o.gustoRateUnit ?? null,
    connecteamRate: o.connecteamRate ?? null, gustoId: o.gustoId ?? "g1", country: o.country ?? null,
    payType: o.payType ?? "hourly", accepted: o.accepted, acceptedBy: o.acceptedBy, excludeMode: o.excludeMode, excludeReason: o.excludeReason,
  };
}
function exc(type: ReadinessException["type"], kind: ReadinessException["kind"]): ReadinessException {
  return { detectKey: `k:${type}`, workerKey: null, workerLabel: null, connecteamUserId: null, type, kind, severity: "MEDIUM", description: "d", ownerAction: "a", source: "connecteam" };
}
function rdw(o: Partial<ReadinessWorker> & { key: string; name: string }): ReadinessWorker {
  return {
    key: o.key, name: o.name, connecteamUserId: o.connecteamUserId ?? 1,
    actualHours: o.actualHours ?? 10, approvedHours: o.approvedHours ?? 10, unapprovedHours: o.unapprovedHours ?? 0,
    plannedHours: o.plannedHours ?? null, issues: o.issues ?? [], status: o.status ?? "READY",
  };
}

function compose(opts: {
  workers: ReviewWorker[];
  readiness: ReadinessWorker[];
  excluded?: ReviewWorker[];
  connecteamOk?: boolean;
  approvalKnown?: boolean;
  gustoStale?: boolean;
  approval?: ComposeInputs["approval"];
  pushedOk?: boolean;
  rate?: ComposeInputs["rate"];
}): PayrollReadinessModel {
  const connecteamOk = opts.connecteamOk ?? true;
  const review: PayrollReviewResult = {
    period: PERIOD, workers: opts.workers, ready: [], review: [], blocked: [],
    excluded: opts.excluded ?? [], excludedCount: (opts.excluded ?? []).length,
    counts: { workers: opts.workers.length, ready: 0, review: 0, blocked: 0 },
    hours: connecteamOk ? opts.workers.reduce((s, w) => s + (w.hours ?? 0), 0) : null,
    blockingIssues: 0, exceptions: 0, missingConfig: 0,
    estReadyPayroll: null, estReviewPayroll: null, estBlockedPayroll: null,
    status: connecteamOk ? "READY" : "NO_DATA", connecteamOk,
  };
  const readiness: PayrollReadiness = {
    period: PERIOD, status: "READY", connecteamOk, approvalKnown: opts.approvalKnown ?? true,
    gusto: { configured: true, fresh: !opts.gustoStale }, workers: opts.readiness,
    exceptions: opts.gustoStale ? [exc("GUSTO_STALE", "UNVERIFIED")] : [],
    counts: { workers: opts.readiness.length, ready: 0, actionRequired: 0, blocked: 0 },
    blocking: 0, anomalies: 0, unverified: 0, hours: review.hours, approvedHours: 10, summary: "",
  };
  return composeReadinessModel({
    period: PERIOD, review, readiness,
    rate: opts.rate ?? { proposals: 0, salaried: 0, noGustoRate: 0, asOf: null },
    approval: opts.approval ?? null, pushedOk: opts.pushedOk ?? false, pushed: opts.pushedOk ? 1 : 0,
    snapshotAt: "2026-10-27T12:00:00.000Z", activity: [],
    sources: { connecteam: true, gusto: true, gustoSnapshotAt: "2026-10-27T11:00:00.000Z", gustoFresh: !opts.gustoStale, instaworkOk: false, instaworkAsOf: null },
    schedule: { deadlineLabel: "Tuesdays 9:00 AM ET", precheckLabel: null, autoSyncLabel: null },
  });
}

const BLOCKER: IssueTag = { kind: "BLOCKING", code: "NO_GUSTO_MAPPING", label: "No Gusto mapping" };
const OVERTIME: IssueTag = { kind: "EXCEPTION", code: "OVERTIME", label: "Overtime" };
const UNAPPROVED = exc("UNAPPROVED_TIMESHEET", "BLOCKING"); // readiness kind irrelevant to the model mapping
const APPROVAL_UNVERIFIED = exc("APPROVAL_UNVERIFIED", "UNVERIFIED");

describe("composeReadinessModel — states", () => {
  it("all clean → READY, counts agree, next action = approve", () => {
    const m = compose({ workers: [rv({ key: "ct:1", name: "A" })], readiness: [rdw({ key: "ct:1", name: "A" })] });
    expect(m.status).toBe("READY");
    expect(m.counts).toMatchObject({ included: 1, ready: 1, actionRequired: 0, blocked: 0, unverified: 0 });
    expect(m.nextAction.gate).toBe("zoeReview");
    expect(m.gates.find((g) => g.key === "timesheetApproval")?.state).toBe("PASS");
  });

  it("unmapped worker → BLOCKED, mapping gate blocked, next action = map to Gusto", () => {
    const m = compose({
      workers: [rv({ key: "ct:1", name: "A", mappingStatus: "UNMATCHED", issues: [BLOCKER] })],
      readiness: [rdw({ key: "ct:1", name: "A" })],
    });
    expect(m.status).toBe("BLOCKED");
    expect(m.counts.blocked).toBe(1);
    expect(m.gates.find((g) => g.key === "gustoMapping")?.state).toBe("BLOCKED");
    expect(m.nextAction.gate).toBe("gustoMapping");
  });

  it("THE CONTRADICTION FIX: mapped + rate present but unapproved timesheet → NOT ready (ACTION_REQUIRED)", () => {
    // review.ts alone would call this worker READY (mapping only); the model reconciles in the Connecteam
    // source-approval gate, so it is ACTION_REQUIRED and the period is never silently READY.
    const m = compose({
      workers: [rv({ key: "ct:1", name: "A" })],
      readiness: [rdw({ key: "ct:1", name: "A", unapprovedHours: 4, issues: [UNAPPROVED] })],
    });
    expect(m.status).toBe("ACTION_REQUIRED");
    expect(m.counts.ready).toBe(0);
    expect(m.counts.actionRequired).toBe(1);
    expect(m.gates.find((g) => g.key === "timesheetApproval")?.state).toBe("ACTION");
    expect(m.nextAction.gate).toBe("timesheetApproval");
    expect(m.workers[0].approvalState).toBe("UNAPPROVED");
  });

  it("overtime anomaly → ACTION_REQUIRED on the zoeReview gate (not a blocker)", () => {
    const m = compose({
      workers: [rv({ key: "ct:1", name: "A", issues: [OVERTIME] })],
      readiness: [rdw({ key: "ct:1", name: "A" })],
    });
    expect(m.status).toBe("ACTION_REQUIRED");
    expect(m.counts.blocked).toBe(0);
    expect(m.gates.find((g) => g.key === "zoeReview")?.state).toBe("ACTION");
  });

  it("accepted review worker → promoted to READY, but accept does NOT clear an unapproved timesheet", () => {
    const accepted = compose({
      workers: [rv({ key: "ct:1", name: "A", issues: [OVERTIME], accepted: true, acceptedBy: "Lisa" })],
      readiness: [rdw({ key: "ct:1", name: "A" })],
    });
    expect(accepted.counts.ready).toBe(1);

    const acceptedButUnapproved = compose({
      workers: [rv({ key: "ct:1", name: "A", issues: [OVERTIME], accepted: true, acceptedBy: "Lisa" })],
      readiness: [rdw({ key: "ct:1", name: "A", unapprovedHours: 2, issues: [UNAPPROVED] })],
    });
    expect(acceptedButUnapproved.counts.ready).toBe(0);
    expect(acceptedButUnapproved.workers[0].status).toBe("ACTION_REQUIRED");
  });

  it("approval field not exposed → UNVERIFIED workers, never READY", () => {
    const m = compose({ workers: [rv({ key: "ct:1", name: "A" })], readiness: [rdw({ key: "ct:1", name: "A", issues: [APPROVAL_UNVERIFIED] })], approvalKnown: false });
    expect(m.status).toBe("ACTION_REQUIRED");
    expect(m.counts.unverified).toBe(1);
    expect(m.gates.find((g) => g.key === "timesheetApproval")?.state).toBe("UNVERIFIED");
  });

  it("connecteam unavailable → UNAVAILABLE, nothing ready", () => {
    const m = compose({ workers: [rv({ key: "ct:1", name: "A" })], readiness: [rdw({ key: "ct:1", name: "A" })], connecteamOk: false });
    expect(m.status).toBe("UNAVAILABLE");
    expect(m.gates.find((g) => g.key === "hours")?.state).toBe("UNAVAILABLE");
    expect(m.nextAction.gate).toBe("hours");
  });

  it("no paid workers → NO_DATA", () => {
    const m = compose({ workers: [], readiness: [] });
    expect(m.status).toBe("NO_DATA");
  });

  it("gusto snapshot stale → never silently READY (ACTION_REQUIRED)", () => {
    const m = compose({ workers: [rv({ key: "ct:1", name: "A" })], readiness: [rdw({ key: "ct:1", name: "A" })], gustoStale: true });
    expect(m.status).toBe("ACTION_REQUIRED");
  });

  it("excluded workers are kept out of the payable counts but accessible", () => {
    const m = compose({
      workers: [rv({ key: "ct:1", name: "A" })],
      readiness: [rdw({ key: "ct:1", name: "A" })],
      excluded: [rv({ key: "ct:9", name: "Z", excludeMode: "permanent", excludeReason: "1099 elsewhere" })],
    });
    expect(m.counts.included).toBe(1);
    expect(m.counts.excluded).toBe(1);
    expect(m.excludedWorkers[0].status).toBe("EXCLUDED");
  });

  it("approved period with clean gates → APPROVED; a draft push → SUBMITTED", () => {
    const approved = compose({ workers: [rv({ key: "ct:1", name: "A" })], readiness: [rdw({ key: "ct:1", name: "A" })], approval: { status: "APPROVED", approvedBy: "Lisa", approvedAt: "x" } });
    expect(approved.status).toBe("APPROVED");
    const submitted = compose({ workers: [rv({ key: "ct:1", name: "A" })], readiness: [rdw({ key: "ct:1", name: "A" })], approval: { status: "APPROVED", approvedBy: "Lisa", approvedAt: "x" }, pushedOk: true });
    expect(submitted.status).toBe("SUBMITTED");
  });
});

describe("composeReadinessModel — rate comparison (three distinct populations)", () => {
  it("separates verified matches, differing, missing-source-rate and salaried", () => {
    // 4 mapped workers; rate plan: 1 differing proposal, 1 no Gusto rate, 1 salaried ⇒ comparable = 4-1-1 = 2,
    // verified = comparable - differing = 1.
    const workers = ["A", "B", "C", "D"].map((n, i) => rv({ key: `ct:${i}`, name: n }));
    const readiness = ["A", "B", "C", "D"].map((n, i) => rdw({ key: `ct:${i}`, name: n }));
    const m = compose({ workers, readiness, rate: { proposals: 1, salaried: 1, noGustoRate: 1, asOf: "x" } });
    expect(m.rateComparison).toMatchObject({ mapped: 4, differing: 1, missingSourceRate: 1, incomparableSalaried: 1, verifiedMatch: 1 });
  });
});

describe("payrollApprovability — gating cannot be bypassed", () => {
  const unapproved = compose({ workers: [rv({ key: "ct:1", name: "A" }), rv({ key: "ct:2", name: "B" })], readiness: [rdw({ key: "ct:1", name: "A" }), rdw({ key: "ct:2", name: "B", unapprovedHours: 3, issues: [UNAPPROVED] })] });

  it("strictly-ready workers are approvable without acknowledgement; unapproved need acknowledgement", () => {
    const noAck = payrollApprovability(unapproved, false);
    expect(noAck.readyKeys).toEqual(["ct:1"]);
    expect(noAck.acknowledgeableKeys).toEqual(["ct:2"]);
    expect(noAck.approvableKeys).toEqual(["ct:1"]);
    expect(noAck.needsAck).toBe(true);

    const withAck = payrollApprovability(unapproved, true);
    expect(withAck.approvableKeys.sort()).toEqual(["ct:1", "ct:2"]);
  });

  it("a hard blocker is never approvable, even with acknowledgement", () => {
    const m = compose({ workers: [rv({ key: "ct:1", name: "A", mappingStatus: "UNMATCHED", issues: [BLOCKER] })], readiness: [rdw({ key: "ct:1", name: "A" })] });
    expect(payrollApprovability(m, true).approvableKeys).toEqual([]);
  });

  it("an unavailable time source blocks all approval", () => {
    const m = compose({ workers: [rv({ key: "ct:1", name: "A" })], readiness: [rdw({ key: "ct:1", name: "A" })], connecteamOk: false });
    const a = payrollApprovability(m, true);
    expect(a.unavailable).toBe(true);
    expect(a.approvableKeys).toEqual([]);
  });
});
