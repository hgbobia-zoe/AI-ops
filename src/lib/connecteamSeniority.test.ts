import { describe, expect, it } from "vitest";
import { seniorityDateOf } from "./connecteam";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

describe("seniorityDateOf", () => {
  it("reads a 'Hire Date' custom field (string date)", () => {
    const u = { customFields: [{ name: "Hire Date", value: "2021-03-15" }] };
    expect(day(seniorityDateOf(u))).toBe("2021-03-15");
  });

  it("reads a 'Start Date' custom field given as epoch seconds", () => {
    const u = { customFields: [{ name: "Start Date", value: 1_615_766_400 }] }; // 2021-03-15 UTC
    expect(day(seniorityDateOf(u))).toBe("2021-03-15");
  });

  it("matches the field name case-insensitively", () => {
    const u = { customFields: [{ name: "HIRE DATE", value: "2020-01-02" }] };
    expect(day(seniorityDateOf(u))).toBe("2020-01-02");
  });

  it("falls back to the account-created date (epoch ms) when there is no hire field", () => {
    const u = { customFields: [{ name: "Title", value: "Driver" }], createdAt: 1_609_459_200_000 }; // 2021-01-01
    expect(day(seniorityDateOf(u))).toBe("2021-01-01");
  });

  it("prefers an explicit hire date over the created date", () => {
    const u = { customFields: [{ name: "Hire Date", value: "2018-06-01" }], createdAt: 1_609_459_200_000 };
    expect(day(seniorityDateOf(u))).toBe("2018-06-01");
  });

  it("returns null when neither is present (never fabricated)", () => {
    expect(seniorityDateOf({ customFields: [{ name: "Title", value: "Driver" }] })).toBeNull();
    expect(seniorityDateOf({})).toBeNull();
  });
});
