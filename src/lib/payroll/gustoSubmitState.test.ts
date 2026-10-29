import { afterEach, describe, it, expect } from "vitest";
import {
  gustoSubmitDisabled,
  periodKey,
  shouldRecordSubmit,
  shouldRecordConfirm,
  isAlreadySubmitted,
  isWireAlreadyConfirmed,
  recordGustoSubmitResult,
  readGustoSubmitResult,
  recordGustoConfirmWireResult,
  readGustoConfirmWireResult,
  type GustoSubmitResult,
  type GustoConfirmWireResult,
} from "./gustoSubmitState";

function submit(over: Partial<GustoSubmitResult> = {}): GustoSubmitResult {
  return {
    key: over.key ?? periodKey("2026-10-19", "2026-10-25"),
    at: over.at ?? new Date().toISOString(),
    ok: over.ok ?? true,
    aborted: over.aborted ?? null,
    submitted: over.submitted ?? true,
    alreadySubmitted: over.alreadySubmitted ?? false,
    draftPayrollId: over.draftPayrollId ?? "d1",
    payrollId: over.payrollId ?? "p1",
    periodStart: over.periodStart ?? "2026-10-19",
    periodEnd: over.periodEnd ?? "2026-10-25",
    checkDate: over.checkDate ?? "2026-10-27",
    uniqueIdentifier: over.uniqueIdentifier ?? "regular.ps.pg.2026-10-27",
    expectedTotal: over.expectedTotal ?? 12500,
    headcount: over.headcount ?? 7,
    wirePathTaken: over.wirePathTaken ?? false,
    errors: over.errors ?? [],
    initiatedBy: over.initiatedBy ?? "Lisa",
  };
}
function confirm(over: Partial<GustoConfirmWireResult> = {}): GustoConfirmWireResult {
  return {
    key: over.key ?? periodKey("2026-10-19", "2026-10-25"),
    at: over.at ?? new Date().toISOString(),
    ok: over.ok ?? true,
    aborted: over.aborted ?? null,
    confirmed: over.confirmed ?? true,
    alreadyConfirmed: over.alreadyConfirmed ?? false,
    periodStart: over.periodStart ?? "2026-10-19",
    periodEnd: over.periodEnd ?? "2026-10-25",
    checkDate: over.checkDate ?? "2026-10-27",
    wireId: over.wireId ?? "w1",
    amount: over.amount ?? 12500,
    gustoAmount: over.gustoAmount ?? 12500,
    wireDate: over.wireDate ?? "2026-10-27",
    errors: over.errors ?? [],
    initiatedBy: over.initiatedBy ?? "Lisa",
  };
}

afterEach(() => {
  delete process.env.GUSTO_SUBMIT_DISABLED;
});

describe("gustoSubmitDisabled (kill switch)", () => {
  it("fail-open: disabled only when the env var is a truthy-ish value", () => {
    delete process.env.GUSTO_SUBMIT_DISABLED;
    expect(gustoSubmitDisabled()).toBe(false);
    for (const off of ["", "0", "false", "off", "no"]) {
      process.env.GUSTO_SUBMIT_DISABLED = off;
      expect(gustoSubmitDisabled()).toBe(false);
    }
    for (const on of ["1", "true", "yes", "disabled"]) {
      process.env.GUSTO_SUBMIT_DISABLED = on;
      expect(gustoSubmitDisabled()).toBe(true);
    }
  });
});

describe("periodKey", () => {
  it("is a stable start..end key", () => {
    expect(periodKey("2026-10-19", "2026-10-25")).toBe("2026-10-19..2026-10-25");
  });
});

describe("shouldRecord* (idempotency authority — pure)", () => {
  it("records the first result", () => {
    expect(shouldRecordSubmit(null)).toBe(true);
    expect(shouldRecordConfirm(null)).toBe(true);
  });
  it("never overwrites an authoritative success", () => {
    expect(shouldRecordSubmit(submit({ ok: true, submitted: true }))).toBe(false);
    expect(shouldRecordConfirm(confirm({ ok: true, confirmed: true }))).toBe(false);
  });
  it("replaces a prior failure/abort (a retry)", () => {
    expect(shouldRecordSubmit(submit({ ok: false, submitted: false, aborted: "submit_failed" }))).toBe(true);
    expect(shouldRecordConfirm(confirm({ ok: false, confirmed: false, aborted: "confirm_failed" }))).toBe(true);
  });
});

describe("isAlreadySubmitted / isWireAlreadyConfirmed", () => {
  it("only an ok + submitted/confirmed result counts", () => {
    expect(isAlreadySubmitted(null)).toBe(false);
    expect(isAlreadySubmitted(submit({ ok: false }))).toBe(false);
    expect(isAlreadySubmitted(submit())).toBe(true);
    expect(isWireAlreadyConfirmed(confirm({ confirmed: false }))).toBe(false);
    expect(isWireAlreadyConfirmed(confirm())).toBe(true);
  });
});

describe("ledger IO + dedupe (KV-backed)", () => {
  it("records then reads a submit, and refuses a duplicate over a success", () => {
    const key = periodKey("2026-10-19", "2026-10-25");
    const first = recordGustoSubmitResult(submit());
    expect(first.recorded).toBe(true);
    expect(readGustoSubmitResult(key)?.submitted).toBe(true);

    // A second, DIFFERENT submit for the same period must NOT overwrite the authoritative success.
    const dup = recordGustoSubmitResult(submit({ draftPayrollId: "d2", payrollId: "p2" }));
    expect(dup.recorded).toBe(false);
    expect(readGustoSubmitResult(key)?.draftPayrollId).toBe("d1"); // original kept
  });

  it("lets a retry replace a prior failed submit", () => {
    const key = periodKey("2026-11-02", "2026-11-08");
    recordGustoSubmitResult(submit({ key, periodStart: "2026-11-02", periodEnd: "2026-11-08", ok: false, submitted: false, aborted: "not_logged_in" }));
    const retry = recordGustoSubmitResult(submit({ key, periodStart: "2026-11-02", periodEnd: "2026-11-08" }));
    expect(retry.recorded).toBe(true);
    expect(readGustoSubmitResult(key)?.ok).toBe(true);
  });

  it("records then reads a wire confirm, and refuses a double confirm", () => {
    const key = periodKey("2026-10-19", "2026-10-25");
    expect(recordGustoConfirmWireResult(confirm()).recorded).toBe(true);
    expect(readGustoConfirmWireResult(key)?.confirmed).toBe(true);
    expect(recordGustoConfirmWireResult(confirm({ wireId: "w2" })).recorded).toBe(false);
    expect(readGustoConfirmWireResult(key)?.wireId).toBe("w1");
  });
});
