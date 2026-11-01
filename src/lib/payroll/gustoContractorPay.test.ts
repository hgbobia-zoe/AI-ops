import { describe, expect, it } from "vitest";
import {
  isContractorPayGroupId,
  parseContractorPayGroupId,
  buildSubmitPayGroupInput,
  parseSubmitPayGroupResponse,
  parseReviewPayGroupResponse,
  parseContractorPayItems,
  buildHoursUpdatesInput,
  buildPaymentPurposeInput,
  buildContractorPlan,
  matchEntriesToMembers,
  parseContractorMembers,
  contractorPayGate,
  CONTRACTOR_DOCS,
  DEFAULT_TRANSFER_PURPOSE,
  type ContractorPlanEntry,
  type ContractorPlanInput,
} from "./gustoContractorPay";

const PG = "contractor_adhoc.87437f30-0c73-41f1-b3a7-5babf47bf7a4.165f220b-89a2-45cb-b6ca-91f42b3f782c";

describe("contractor pay group id", () => {
  it("recognizes a well-formed id and rejects others", () => {
    expect(isContractorPayGroupId(PG)).toBe(true);
    expect(isContractorPayGroupId("regular.87437f30-0c73-41f1-b3a7-5babf47bf7a4.a0.2026-11-01")).toBe(false);
    expect(isContractorPayGroupId("contractor_adhoc.short.short")).toBe(false);
    expect(isContractorPayGroupId(null)).toBe(false);
  });
  it("extracts the id from a URL", () => {
    expect(parseContractorPayGroupId(`https://app.gusto.com/zoe/pay/contractors/ad-hoc/${PG}/inputs`)).toBe(PG);
    expect(parseContractorPayGroupId("https://app.gusto.com/zoe/pay")).toBeNull();
  });
});

describe("buildSubmitPayGroupInput", () => {
  it("always sets requestedPayoutRail null and the bank/unblock fields null (never-expedite invariant)", () => {
    const input = buildSubmitPayGroupInput({ payGroupId: PG, dataHash: "h1", dataHashExcludingFundingMethod: "h2" });
    expect(input).toEqual({
      acknowledgedBlockedMemberIds: null,
      bankScreenshot: null,
      expectedDataHash: "h1",
      expectedDataHashExcludingFundingMethod: "h2",
      payGroupId: PG,
      requestedPayoutRail: null,
      selectedUnblockOptionType: null,
    });
  });
  it("carries acknowledged blocked ids only when given", () => {
    expect(buildSubmitPayGroupInput({ payGroupId: PG, dataHash: "h", dataHashExcludingFundingMethod: "h", acknowledgedBlockedMemberIds: ["m1"] }).acknowledgedBlockedMemberIds).toEqual(["m1"]);
  });
});

describe("parseSubmitPayGroupResponse", () => {
  it("classifies a success and returns the pay group id", () => {
    const r = parseSubmitPayGroupResponse({ data: { submitPayGroup: { result: { __typename: "SubmitPayGroupSuccess", payGroup: { id: PG } } } } });
    expect(r.outcome).toBe("submitted");
    expect(r.payGroupId).toBe(PG);
  });
  it("classifies blocked members", () => {
    const r = parseSubmitPayGroupResponse({ data: { submitPayGroup: { result: { __typename: "SubmitPayGroupBlockedMembers", blockedMembers: [{ member: { id: "m1", preferredFullName: "Jessie Medalla" }, payBlockers: [{ code: "NO_BANK", message: "No bank account" }] }] } } } });
    expect(r.outcome).toBe("blocked");
    expect(r.blockedMembers[0]).toMatchObject({ memberId: "m1", name: "Jessie Medalla" });
    expect(r.blockedMembers[0].blockers[0].code).toBe("NO_BANK");
  });
  it("classifies a failure and treats 'already submitted' as idempotent", () => {
    const fail = parseSubmitPayGroupResponse({ data: { submitPayGroup: { result: { __typename: "SubmitPayGroupFailure", error: { __typename: "SubmitContractorPayGroupError", submitContractorPayGroupErrorCode: "X", message: "something broke" } } } } });
    expect(fail.outcome).toBe("failed");
    expect(fail.errors[0]).toEqual({ code: "X", message: "something broke" });

    const already = parseSubmitPayGroupResponse({ data: { submitPayGroup: { result: { __typename: "SubmitPayGroupFailure", error: { __typename: "SubmitContractorPayGroupError", code: "ALREADY", message: "This pay group is not a draft (already submitted)." } } } } });
    expect(already.outcome).toBe("already_submitted");
  });
  it("never returns a false success on a malformed shape", () => {
    expect(parseSubmitPayGroupResponse(null).outcome).toBe("failed");
    expect(parseSubmitPayGroupResponse({ data: {} }).outcome).toBe("failed");
    expect(parseSubmitPayGroupResponse({ errors: [{ message: "unauthorized" }] }).outcome).toBe("failed");
  });
});

describe("parseReviewPayGroupResponse", () => {
  it("returns both data hashes and the funding result on success", () => {
    const r = parseReviewPayGroupResponse({
      data: { reviewPayGroup: { result: {
        __typename: "ReviewContractorPayGroupSuccess",
        dataHash: "DH", dataHashExcludingFundingMethod: "DHX",
        payGroupInterface: { id: PG },
        riskResult: { __typename: "ReviewPaymentRisk", wireInFunded: true, isReverseWireFunded: false, achSpeed: "STANDARD", isBankScreenshotRequired: false, wireCutoffTime: "14:00", wireInReason: "balance", submitBlockers: [] },
      } } },
    });
    expect(r.outcome).toBe("reviewed");
    expect(r.dataHash).toBe("DH");
    expect(r.dataHashExcludingFundingMethod).toBe("DHX");
    expect(r.funding).toMatchObject({ wireInFunded: true, achSpeed: "STANDARD" });
  });
  it("feeds straight into the submit input (the review -> submit handshake)", () => {
    const review = parseReviewPayGroupResponse({ data: { reviewPayGroup: { result: { __typename: "ReviewContractorPayGroupSuccess", dataHash: "DH", dataHashExcludingFundingMethod: "DHX", payGroupInterface: { id: PG }, riskResult: null } } } });
    const input = buildSubmitPayGroupInput({ payGroupId: PG, dataHash: review.dataHash!, dataHashExcludingFundingMethod: review.dataHashExcludingFundingMethod! });
    expect(input.expectedDataHash).toBe("DH");
    expect(input.expectedDataHashExcludingFundingMethod).toBe("DHX");
  });
  it("flags fx refresh in progress and blocked members distinctly", () => {
    expect(parseReviewPayGroupResponse({ data: { reviewPayGroup: { result: { __typename: "ReviewPayGroupFxRateRefreshInProgress", fxRateRefreshProgress: { totalItems: 2, completedItems: 1 } } } } }).outcome).toBe("fx_refreshing");
    expect(parseReviewPayGroupResponse({ data: { reviewPayGroup: { result: { __typename: "ReviewPayGroupBlockedMembers", blockedMembers: [{ member: { id: "m1", preferredFullName: "X" }, payBlockers: [] }] } } } }).outcome).toBe("blocked");
  });
  it("never returns hashes on a failure", () => {
    const r = parseReviewPayGroupResponse({ data: { reviewPayGroup: { result: { __typename: "ReviewPayGroupFailure", error: { __typename: "ReviewContractorPayGroupError", reviewContractorPayGroupErrorCode: "E", message: "bad" } } } } });
    expect(r.outcome).toBe("failed");
    expect(r.dataHash).toBeNull();
  });
});

describe("parseContractorPayItems", () => {
  const resp = {
    data: { company: { id: "co", payGroupInterface: { __typename: "ContractorPayGroup", id: PG, payItemInterfacesByMemberIds: [
      { __typename: "ContractorPayItem", id: "pi_us", isIncludedInPayGroup: true,
        member: { id: "m_us", name: { fullName: "Mayerlin Alvarado Montegut" } },
        workedHours: { id: "wh_us", regularHours: 8 }, fixedPayments: [],
        calculatedAmounts: { totalDebitAmount: { amount: 144, currencyCode: "USD" } },
        contractor: { __typename: "UnifiedDomesticContractor", country: "United States" }, payBlockers: [] },
      { __typename: "ContractorPayItem", id: "pi_ph", isIncludedInPayGroup: true,
        member: { id: "m_ph", name: { fullName: "Jessie Medalla" } },
        workedHours: { id: "wh_ph", regularHours: null }, fixedPayments: [{ paymentAmount: { amount: 90, currencyCode: "USD" } }],
        calculatedAmounts: { totalDebitAmount: { amount: 90, currencyCode: "USD" } },
        contractor: { __typename: "UnifiedInternationalContractor", country: "PH" },
        payBlockers: [{ code: "NO_BANK", message: "Missing bank details" }] },
    ] } } },
  };
  it("parses US and international rows with hours, flat pay, debit and blockers", () => {
    const items = parseContractorPayItems(resp);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ payItemId: "pi_us", memberId: "m_us", name: "Mayerlin Alvarado Montegut", country: "United States", isInternational: false, regularHours: 8, workedHoursId: "wh_us", totalDebitAmount: 144, currency: "USD", included: true });
    expect(items[1]).toMatchObject({ payItemId: "pi_ph", isInternational: true, regularHours: null, fixedPaymentAmount: 90 });
    expect(items[1].payBlockers[0].code).toBe("NO_BANK");
  });
  it("returns [] on a malformed response", () => {
    expect(parseContractorPayItems(null)).toEqual([]);
    expect(parseContractorPayItems({ data: {} })).toEqual([]);
  });
});

describe("buildHoursUpdatesInput (captured AutoSaveContractorHours)", () => {
  it("batches every contractor in one input with hours as 2-decimal strings", () => {
    expect(buildHoursUpdatesInput(PG, [{ memberUuid: "m1", hours: 1.5 }, { memberUuid: "m2", hours: 7.3333 }])).toEqual({
      payGroupId: PG,
      hoursUpdates: [{ memberUuid: "m1", hours: "1.5" }, { memberUuid: "m2", hours: "7.33" }],
    });
  });
  it("builds the transfer-purpose input with the default code", () => {
    expect(buildPaymentPurposeInput(PG, ["p1"])).toEqual({ payGroupId: PG, paymentPurposeUpdates: [{ memberUuid: "p1", paymentPurpose: DEFAULT_TRANSFER_PURPOSE }] });
  });
  it("never ships a pay (SubmitPayGroup) document to the extension", () => {
    expect(Object.values(CONTRACTOR_DOCS).some((d) => /SubmitPayGroup|submitPayGroup/.test(d))).toBe(false);
  });
});

describe("parseContractorMembers", () => {
  it("reads the draft's contractors with country + international flag", () => {
    const json = { data: { company: { payGroupInterface: { payItemsMetadata: [
      { memberUuid: "a", preferredFirstName: "Mayerlin", lastName: "Alvarado Montegut", country: "United States" },
      { memberUuid: "b", legalFirstName: "Princess", lastName: "Malajito", country: "Philippines" },
      { id: "no-uuid" },
    ] } } } };
    expect(parseContractorMembers(json)).toEqual([
      { memberUuid: "a", name: "Mayerlin Alvarado Montegut", country: "United States", international: false },
      { memberUuid: "b", name: "Princess Malajito", country: "Philippines", international: true },
    ]);
    expect(parseContractorMembers(null)).toEqual([]);
  });
});

describe("buildContractorPlan", () => {
  const w = (o: Partial<ContractorPlanInput>): ContractorPlanInput => ({ key: "k", name: "N", workerType: "US_CONTRACTOR", hours: 10, payRate: 18, gustoId: "g", ...o });
  it("readies mapped contractors with hours and skips W2 staff", () => {
    const p = buildContractorPlan([w({ key: "may" }), w({ key: "emp", workerType: "EMPLOYEE" })]);
    expect(p.rows.map((r) => r.key)).toEqual(["may"]);
    expect(p.entries).toEqual([{ key: "may", gustoId: "g", name: "N", hours: 10, international: false }]);
    expect(p.estTotal).toBe(180);
  });
  it("flags a contractor with no Gusto match for a decision, and exclusion clears it (Raquel rule)", () => {
    const raquel = w({ key: "raq", name: "Raquel", gustoId: null });
    const before = buildContractorPlan([raquel]);
    expect(before.rows[0].status).toBe("no_gusto_match");
    expect(before.entries).toHaveLength(0);
    expect(before.needsDecision).toBe(1);
    const after = buildContractorPlan([raquel], ["raq"]);
    expect(after.rows[0].status).toBe("excluded");
    expect(after.needsDecision).toBe(0);
  });
  it("flags international pay under $25 (Gusto minimum, seen live)", () => {
    const p = buildContractorPlan([w({ key: "pri", workerType: "INTERNATIONAL_CONTRACTOR", hours: 2, payRate: 10 })]);
    expect(p.rows[0].status).toBe("below_minimum");
    expect(p.entries).toHaveLength(0);
  });
  it("does not push contractors with no hours or no rate", () => {
    const p = buildContractorPlan([w({ key: "a", hours: 0 }), w({ key: "b", payRate: null })]);
    expect(p.rows.map((r) => r.status)).toEqual(["no_hours", "no_rate"]);
    expect(p.entries).toHaveLength(0);
  });
});

describe("matchEntriesToMembers", () => {
  const members = [
    { memberUuid: "u-may", name: "Mayerlin Alvarado Montegut", country: "United States", international: false },
    { memberUuid: "u-jes", name: "Jessie Medalla", country: "Philippines", international: true },
  ];
  const e = (o: Partial<ContractorPlanEntry>): ContractorPlanEntry => ({ key: "k", gustoId: null, name: "", hours: 1, international: false, ...o });
  it("matches by Gusto id first, then by name tokens (accents/order ignored)", () => {
    const r = matchEntriesToMembers([e({ key: "a", gustoId: "u-jes", name: "whatever" }), e({ key: "b", name: "Mayerlín Alvarado" })], members);
    expect(r.matched.map((m) => [m.entry.key, m.member.memberUuid, m.by])).toEqual([["a", "u-jes", "id"], ["b", "u-may", "name"]]);
    expect(r.unmatched).toHaveLength(0);
  });
  it("never guesses: unknown names stay unmatched", () => {
    expect(matchEntriesToMembers([e({ name: "Raquel Someone" })], members).unmatched).toHaveLength(1);
  });
});

describe("contractorPayGate", () => {
  it("blocks until confirmed, once submitted, and when disabled", () => {
    expect(contractorPayGate({ confirmed: false, alreadySubmitted: false, disabled: false }).canPay).toBe(false);
    expect(contractorPayGate({ confirmed: true, alreadySubmitted: true, disabled: false }).canPay).toBe(false);
    expect(contractorPayGate({ confirmed: true, alreadySubmitted: false, disabled: true }).canPay).toBe(false);
    expect(contractorPayGate({ confirmed: true, alreadySubmitted: false, disabled: false }).canPay).toBe(true);
  });
});
