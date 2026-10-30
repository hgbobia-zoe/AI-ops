import { describe, expect, it } from "vitest";
import {
  isContractorPayGroupId,
  parseContractorPayGroupId,
  buildSubmitPayGroupInput,
  parseSubmitPayGroupResponse,
  parseReviewPayGroupResponse,
  parseContractorPayItems,
  buildUpdateWorkedHoursInput,
  contractorPayGate,
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

describe("buildUpdateWorkedHoursInput (provisional)", () => {
  it("builds the per-pay-item push input", () => {
    expect(buildUpdateWorkedHoursInput({ payGroupId: PG, payItemId: "pi_us", workedHoursId: "wh_us", regularHours: 8 })).toEqual({ payGroupId: PG, payItemId: "pi_us", workedHoursId: "wh_us", regularHours: 8 });
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
