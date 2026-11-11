import { describe, expect, it } from "vitest";
import { normalizeDeposit, matchDeposit, projectNumbersIn, type DepositCandidate } from "./bankDeposit";

const cand = (id: string, grandTotal: number, amountDue: number | null, over: Partial<DepositCandidate> = {}): DepositCandidate => ({
  bookingId: id,
  signed: true,
  archived: false,
  eventDate: "2026-12-12",
  grandTotal,
  amountDue,
  ...over,
});

describe("normalizeDeposit", () => {
  it("reads Mercury's fields and joins the memo text", () => {
    const d = normalizeDeposit({ transactionId: "m-1", amount: "1,026.51", postedAt: "2026-11-06T14:00:00Z", note: "Project 231812125", counterpartyName: "Check Deposit", accountName: "Check Deposit", status: "sent" });
    expect(d).toEqual({ depositId: "m-1", amount: 1026.51, postedAt: "2026-11-06T14:00:00.000Z", description: "Project 231812125 | Check Deposit", account: "Check Deposit", status: "sent" });
  });
});

describe("projectNumbersIn", () => {
  it("finds 9 digit project numbers, not longer account numbers", () => {
    expect(projectNumbersIn("Check 1042 for Project #231812125, acct 1234567890123")).toEqual(["231812125"]);
  });
});

describe("matchDeposit", () => {
  const known = new Set(["231812125"]);
  it("prefers a known project number in the memo", () => {
    const m = matchDeposit({ amount: 5, description: "proj 231812125" }, known, [cand("999999999", 10, 10)]);
    expect(m).toMatchObject({ bookingId: "231812125", kind: "project_number" });
  });

  it("ignores an unknown number and falls back to the amount", () => {
    const m = matchDeposit({ amount: 900, description: "ref 123456789" }, known, [cand("A", 1800, 1800)]);
    expect(m).toMatchObject({ bookingId: "A", kind: "deposit_50" });
  });

  it("matches the amount due or the full total on exactly one signed project", () => {
    expect(matchDeposit({ amount: 700, description: "" }, known, [cand("A", 1800, 700)])).toMatchObject({ bookingId: "A", kind: "amount_due" });
    expect(matchDeposit({ amount: 1800, description: "" }, known, [cand("A", 1800, 0)])).toMatchObject({ bookingId: "A", kind: "full_total" });
  });

  it("links nothing when two projects fit", () => {
    const m = matchDeposit({ amount: 900, description: "" }, known, [cand("A", 1800, 1800), cand("B", 900, 900)]);
    expect(m.bookingId).toBeNull();
    expect(m.kind).toBe("ambiguous");
  });

  it("skips unsigned and archived projects", () => {
    const m = matchDeposit({ amount: 900, description: "" }, known, [cand("A", 1800, 1800, { signed: false }), cand("B", 1800, 1800, { archived: true })]);
    expect(m.kind).toBe("none");
  });
});
