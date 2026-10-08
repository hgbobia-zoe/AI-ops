import { describe, it, expect } from "vitest";
import { parseGustoMembers, parseGustoPayPeriods, parseGustoPayRate, attachPayRates } from "./gustoSnapshot";
import { gustoIsInternational } from "./gusto";

const payResponse = (amount: string, unit: string) => ({
  data: { member: { company: { memberCompensationEmployeeCard: { jobs: [{ currentCompensation: { details: { paymentAmount: { amount, currencyCode: "USD" }, paymentUnit: unit } } }] } } } },
});

// Representative MembersTable response (the real captured shape: data.company.members.nodes[]).
const membersResponse = {
  data: {
    company: {
      id: "co_1",
      members: {
        nodes: [
          { id: "m1", personType: "Employee", legalFirstName: "James", lastName: "Cobbs", preferredFullName: "James Cobbs", businessName: null, department: "Operations", jobTitle: "Driver", currentEmploymentTypeEntityUuid: "e1", country: "United States of America", __typename: "X" },
          { id: "m2", personType: "Contractor", legalFirstName: "Princess", lastName: "Malajito", preferredFullName: "Princess Malajito", businessName: "PM Co", department: null, jobTitle: "Digital Sales Marketer", currentEmploymentTypeEntityUuid: "e2", country: "Philippines", __typename: "X" },
          { personType: "Employee", legalFirstName: "NoId" }, // missing id → skipped
        ],
        __typename: "Conn",
      },
      tradeOrLegalName: "Zoe",
    },
  },
};

const timeResponse = {
  data: {
    company: {
      id: "co_1",
      timeTrackingPayPeriods: [
        { id: "pp1", displayName: "Oct 5 – Oct 11", startDate: "2026-10-05", endDate: "2026-10-11", status: "OPEN", approvalsStatus: "PENDING", payScheduleId: "ps1", lastExportedToPayroll: null, __typename: "PP" },
      ],
    },
  },
};

describe("parseGustoMembers", () => {
  it("extracts members, lowercases personType, and skips rows without an id", () => {
    const m = parseGustoMembers(membersResponse);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ id: "m1", personType: "employee", firstName: "James", lastName: "Cobbs", country: "United States of America", jobTitle: "Driver" });
    expect(m[1]).toMatchObject({ id: "m2", personType: "contractor", country: "Philippines" });
  });
  it("returns [] for a malformed response (never throws)", () => {
    expect(parseGustoMembers(null)).toEqual([]);
    expect(parseGustoMembers({ data: {} })).toEqual([]);
  });
});

describe("parseGustoPayPeriods", () => {
  it("extracts pay periods with status + dates", () => {
    const p = parseGustoPayPeriods(timeResponse);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: "pp1", startDate: "2026-10-05", endDate: "2026-10-11", status: "OPEN", approvalsStatus: "PENDING" });
  });
  it("returns [] when the field is absent", () => {
    expect(parseGustoPayPeriods({ data: { company: {} } })).toEqual([]);
  });
});

describe("parseGustoPayRate", () => {
  it("extracts the hourly amount, currency, and unit", () => {
    expect(parseGustoPayRate(payResponse("25.00", "Hour"))).toEqual({ amount: 25, currency: "USD", unit: "Hour" });
  });
  it("reads a contractor's rate from memberCompensationCard (not the employee card)", () => {
    const contractor = { data: { member: { company: { memberCompensationCard: { jobs: [{ currentCompensation: { details: { paymentAmount: { amount: "28.00", currencyCode: "USD" }, paymentUnit: "Hour" } } }] } } } } };
    expect(parseGustoPayRate(contractor)).toEqual({ amount: 28, currency: "USD", unit: "Hour" });
  });
  it("returns nulls for a missing compensation card", () => {
    expect(parseGustoPayRate({ data: { member: { company: {} } } })).toEqual({ amount: null, currency: null, unit: null });
    expect(parseGustoPayRate(null)).toEqual({ amount: null, currency: null, unit: null });
  });
});

describe("attachPayRates", () => {
  it("merges parsed rates onto members by id, leaving unmatched members untouched", () => {
    const members = parseGustoMembers({
      data: { company: { members: { nodes: [
        { id: "m1", personType: "Employee", legalFirstName: "A", lastName: "B" },
        { id: "m2", personType: "Employee", legalFirstName: "C", lastName: "D" },
      ] } } },
    });
    attachPayRates(members, { m1: payResponse("30.5", "Hour") });
    expect(members.find((m) => m.id === "m1")).toMatchObject({ payRate: 30.5, payCurrency: "USD", payUnit: "Hour" });
    expect(members.find((m) => m.id === "m2")).toMatchObject({ payRate: null });
  });
});

describe("gustoIsInternational", () => {
  it("treats US variants as domestic and everything else as international", () => {
    expect(gustoIsInternational("United States of America")).toBe(false);
    expect(gustoIsInternational("USA")).toBe(false);
    expect(gustoIsInternational("us")).toBe(false);
    expect(gustoIsInternational("Philippines")).toBe(true);
    expect(gustoIsInternational(null)).toBe(false); // unknown → not assumed international
  });
});
