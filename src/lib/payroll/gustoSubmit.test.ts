import { describe, it, expect } from "vitest";
import {
  buildSubmitDraftPayrollInput,
  buildSubmitUniqueIdentifier,
  parseRunPayrollUniqueIdentifier,
  uniqueIdentifierCheckDate,
  matchesTargetCheckDate,
  parseSubmitDraftPayrollResponse,
  buildConfirmWireInInput,
  verifyWireAmount,
  parseConfirmWireResponse,
  expectedCheckDate,
  buildSubmitContext,
  runPayrollGate,
  confirmWireGate,
  WIRE_BANK_NAME,
} from "./gustoSubmit";
import type { PayrollReadinessModel } from "./types";

describe("buildSubmitDraftPayrollInput — WIRE ONLY invariant", () => {
  it("ALWAYS sets requestedPayoutRail null and subscribeAndRunWithNextDayAch false", () => {
    const input = buildSubmitDraftPayrollInput("regular.ps.pg.2026-11-03");
    expect(input).toEqual({
      requestedPayoutRail: null,
      subscribeAndRunWithNextDayAch: false,
      uniqueIdentifier: "regular.ps.pg.2026-11-03",
    });
  });
  it("never produces an ACH/expedite rail for ANY identifier (property-style sweep)", () => {
    for (const id of ["a", "regular.x.y.2026-01-01", "", "zzz"]) {
      const input = buildSubmitDraftPayrollInput(id);
      expect(input.requestedPayoutRail).toBeNull();
      expect(input.subscribeAndRunWithNextDayAch).toBe(false);
      // no extra keys that could carry a rail
      expect(Object.keys(input).sort()).toEqual(["requestedPayoutRail", "subscribeAndRunWithNextDayAch", "uniqueIdentifier"]);
    }
  });
});

describe("uniqueIdentifier helpers", () => {
  it("composes the regular.<ps>.<pg>.<checkDate> shape", () => {
    expect(buildSubmitUniqueIdentifier("ps-1", "pg-1", "2026-11-03")).toBe("regular.ps-1.pg-1.2026-11-03");
  });
  it("parses the id out of a Run-payroll link href", () => {
    const href = "/payrolls/run?uniqueIdentifier=regular.1a2b3c4d-aa.9f8e7d6c-bb.2026-11-03&foo=1";
    expect(parseRunPayrollUniqueIdentifier(href)).toBe("regular.1a2b3c4d-aa.9f8e7d6c-bb.2026-11-03");
  });
  it("returns null when no id is present", () => {
    expect(parseRunPayrollUniqueIdentifier("/payrolls")).toBeNull();
    expect(parseRunPayrollUniqueIdentifier(null)).toBeNull();
  });
  it("extracts + matches the trailing check date", () => {
    const id = "regular.1a2b3c4d-aa.9f8e7d6c-bb.2026-11-03";
    expect(uniqueIdentifierCheckDate(id)).toBe("2026-11-03");
    expect(matchesTargetCheckDate(id, "2026-11-03")).toBe(true);
    expect(matchesTargetCheckDate(id, "2026-10-27")).toBe(false);
    expect(matchesTargetCheckDate(id, null)).toBe(true); // no target → accept (single-draft case)
  });
});

describe("parseSubmitDraftPayrollResponse", () => {
  it("classifies a success with the draft + payroll ids", () => {
    const json = { data: { submitDraftPayroll: { result: { __typename: "SubmitDraftPayrollSuccess", draftPayroll: { id: "d1", payroll: { id: "p1" } } } } } };
    expect(parseSubmitDraftPayrollResponse(json)).toEqual({ outcome: "submitted", draftPayrollId: "d1", payrollId: "p1", errors: [] });
  });
  it("classifies a failure with its errors", () => {
    const json = { data: { submitDraftPayroll: { result: { __typename: "SubmitDraftPayrollFailure", errors: [{ argument: "checkDate", message: "Invalid check date" }] } } } };
    const r = parseSubmitDraftPayrollResponse(json);
    expect(r.outcome).toBe("failed");
    expect(r.errors).toEqual([{ argument: "checkDate", message: "Invalid check date" }]);
  });
  it("treats an 'already submitted / not a draft' failure as already_submitted (idempotent)", () => {
    const json = { data: { submitDraftPayroll: { result: { __typename: "SubmitDraftPayrollFailure", errors: [{ argument: null, message: "Payroll was already submitted" }] } } } };
    expect(parseSubmitDraftPayrollResponse(json).outcome).toBe("already_submitted");
  });
  it("defensive: a broken shape is a failure, never a false success", () => {
    expect(parseSubmitDraftPayrollResponse(null).outcome).toBe("failed");
    expect(parseSubmitDraftPayrollResponse({}).outcome).toBe("failed");
  });
});

describe("buildConfirmWireInInput", () => {
  it("matches the captured spec exactly", () => {
    expect(buildConfirmWireInInput({ amount: 12345.67, wireDate: "2026-11-03", wireId: "w-1" })).toEqual({
      amount: 12345.67,
      bankName: WIRE_BANK_NAME,
      note: "",
      wireDate: "2026-11-03",
      wireId: "w-1",
      wireType: "WIRE_IN_REQUEST",
    });
  });
});

describe("verifyWireAmount", () => {
  it("uses the app amount when it matches Gusto", () => {
    expect(verifyWireAmount(1000, 1000)).toEqual({ ok: true, amount: 1000, mismatch: false });
  });
  it("REFUSES when app and Gusto disagree beyond epsilon (never confirm a wrong amount)", () => {
    const r = verifyWireAmount(1000, 1200);
    expect(r.ok).toBe(false);
    expect(r.mismatch).toBe(true);
  });
  it("uses whichever single amount is known", () => {
    expect(verifyWireAmount(null, 950).amount).toBe(950);
    expect(verifyWireAmount(950, null).amount).toBe(950);
  });
  it("fails when neither is a usable amount", () => {
    expect(verifyWireAmount(null, null).ok).toBe(false);
    expect(verifyWireAmount(0, -5).ok).toBe(false);
  });
});

describe("parseConfirmWireResponse", () => {
  it("success:true → confirmed", () => {
    expect(parseConfirmWireResponse({ data: { confirmWireIn: { success: true, errors: [] } } }).outcome).toBe("confirmed");
  });
  it("'already confirmed' error → already_confirmed", () => {
    expect(parseConfirmWireResponse({ data: { confirmWireIn: { success: false, errors: [{ message: "Wire already confirmed" }] } } }).outcome).toBe("already_confirmed");
  });
  it("other failure → failed with errors", () => {
    const r = parseConfirmWireResponse({ data: { confirmWireIn: { success: false, errors: [{ argument: "amount", message: "nope" }] } } });
    expect(r.outcome).toBe("failed");
    expect(r.errors).toEqual([{ argument: "amount", message: "nope" }]);
  });
});

describe("expectedCheckDate", () => {
  it("finds the first payrollDay (Tue=2) strictly after a Sunday period end", () => {
    // 2026-10-25 is a Sunday; the Tuesday after is 2026-10-27.
    expect(expectedCheckDate("2026-10-25", 2)).toBe("2026-10-27");
  });
  it("is strictly after the end even when the end IS the payroll day", () => {
    // 2026-10-27 is a Tuesday; next Tuesday is 2026-11-03.
    expect(expectedCheckDate("2026-10-27", 2)).toBe("2026-11-03");
  });
});

// ── Context building + gating ───────────────────────────────────────────────────────────────────────────
function model(over: Partial<{ included: number; estGross: number | null; approval: "APPROVED" | "PENDING" | null }> = {}): Pick<PayrollReadinessModel, "period" | "counts" | "totals" | "approval"> {
  return {
    period: { start: "2026-10-19", end: "2026-10-25", label: "Oct 19 – Oct 25" },
    counts: { included: over.included ?? 7, ready: 7, actionRequired: 0, blocked: 0, unverified: 0, excluded: 0 },
    totals: { hours: 280, estGross: over.estGross === undefined ? 12500 : over.estGross, estGrossPartial: false, approvedHours: 280 },
    approval: over.approval === null || over.approval === undefined ? (over.approval === null ? null : { status: "APPROVED", approvedBy: "Lisa", approvedAt: "2026-10-26T12:00:00Z" }) : { status: over.approval, approvedBy: "Lisa", approvedAt: "2026-10-26T12:00:00Z" },
  };
}

describe("buildSubmitContext", () => {
  it("derives period, check date, estimate total, headcount, approved", () => {
    const ctx = buildSubmitContext({ model: model(), payrollDay: 2, alreadySubmitted: false, disabled: false });
    expect(ctx.period.label).toBe("Oct 19 – Oct 25");
    expect(ctx.checkDate).toBe("2026-10-27"); // Tue after Sun Oct 25
    expect(ctx.expectedTotal).toBe(12500);
    expect(ctx.headcount).toBe(7);
    expect(ctx.approved).toBe(true);
    expect(ctx.alreadySubmitted).toBe(false);
  });
  it("carries a null estimate honestly (no rates)", () => {
    const ctx = buildSubmitContext({ model: model({ estGross: null }), payrollDay: 2, alreadySubmitted: false, disabled: false });
    expect(ctx.expectedTotal).toBeNull();
  });
});

describe("runPayrollGate (Admin trigger gating)", () => {
  it("allows when approved, not submitted, not disabled", () => {
    expect(runPayrollGate({ approved: true, alreadySubmitted: false, disabled: false })).toEqual({ canRun: true, reason: "" });
  });
  it("blocks when disabled (kill switch wins)", () => {
    expect(runPayrollGate({ approved: true, alreadySubmitted: false, disabled: true }).canRun).toBe(false);
  });
  it("blocks when already submitted (no double submit)", () => {
    expect(runPayrollGate({ approved: true, alreadySubmitted: true, disabled: false }).canRun).toBe(false);
  });
  it("blocks when not yet approved in Zoe", () => {
    expect(runPayrollGate({ approved: false, alreadySubmitted: false, disabled: false }).canRun).toBe(false);
  });
});

describe("confirmWireGate", () => {
  it("blocks before an authoritative submit", () => {
    expect(confirmWireGate(null, null).canConfirm).toBe(false);
    expect(confirmWireGate({ ok: false, submitted: false }, null).canConfirm).toBe(false);
  });
  it("allows after a submit, before a confirm", () => {
    expect(confirmWireGate({ ok: true, submitted: true }, null)).toEqual({ canConfirm: true, reason: "" });
  });
  it("blocks a double confirm", () => {
    expect(confirmWireGate({ ok: true, submitted: true }, { ok: true, confirmed: true }).canConfirm).toBe(false);
  });
});
