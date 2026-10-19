import { describe, it, expect } from "vitest";
import { shouldPost, readinessSummaryCard, exceptionCard } from "./slack";
import type { PayrollReadiness, ReadinessException, PayPeriod } from "./types";

const period: PayPeriod = { start: "2026-10-05", end: "2026-10-11", label: "Oct 5 – Oct 11" };

describe("shouldPost — content-hash dedup (idempotent Slack posting, §5)", () => {
  it("posts when the key is new", () => {
    expect(shouldPost({}, "summary:precheck:p1", "abc")).toBe(true);
  });
  it("skips when the same content was already posted", () => {
    expect(shouldPost({ "summary:precheck:p1": "abc" }, "summary:precheck:p1", "abc")).toBe(false);
  });
  it("re-posts when the content hash changed", () => {
    expect(shouldPost({ "summary:precheck:p1": "abc" }, "summary:precheck:p1", "def")).toBe(true);
  });
});

function readiness(p: Partial<PayrollReadiness>): PayrollReadiness {
  return {
    period, status: p.status ?? "READY", connecteamOk: p.connecteamOk ?? true, approvalKnown: p.approvalKnown ?? true,
    gusto: p.gusto ?? { configured: true, fresh: true }, workers: p.workers ?? [], exceptions: p.exceptions ?? [],
    counts: p.counts ?? { workers: 3, ready: 3, actionRequired: 0, blocked: 0 },
    blocking: p.blocking ?? 0, anomalies: p.anomalies ?? 0, unverified: p.unverified ?? 0,
    hours: p.hours ?? 72, approvedHours: p.approvedHours ?? 72, summary: p.summary ?? "Payroll READY — 3 workers.",
  };
}

const exc: ReadinessException = {
  detectKey: "RDY:2026-10-05:2026-10-11:ct:1:UNAPPROVED_TIMESHEET",
  workerKey: "ct:1", workerLabel: "Marquis", connecteamUserId: 1,
  type: "UNAPPROVED_TIMESHEET", kind: "BLOCKING", severity: "HIGH",
  description: "Marquis has 10h of unapproved time.", ownerAction: "Approve the timesheet in Connecteam.", source: "connecteam",
};

describe("card builders", () => {
  it("summary card carries the status + counts and a flattenable title", () => {
    const card = readinessSummaryCard(readiness({ status: "BLOCKED", blocking: 1, counts: { workers: 3, ready: 2, actionRequired: 0, blocked: 1 }, exceptions: [exc] }), "precheck");
    expect(card.title).toContain("Blocked");
    expect(card.fields?.some((f) => f.label === "Status" && f.value === "Blocked")).toBe(true);
    expect(card.body).toContain("Marquis");
  });

  it("exception card names the worker, the evidence, and the owner action", () => {
    const card = exceptionCard(exc, period.label);
    expect(card.fields?.some((f) => f.label === "Worker" && f.value === "Marquis")).toBe(true);
    expect(card.body).toContain("Approve the timesheet");
    expect(card.context).toMatch(/re-checks the Connecteam record/i);
  });
});
